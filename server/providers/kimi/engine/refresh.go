package main

import (
    "bytes"
    "encoding/base64"
    "encoding/json"
    "fmt"
    "io"
    "log"
    "net/http"
    "os"
    "path/filepath"
    "strings"
    "sync"
    "time"
)

const (
    kimiRefreshURL       = "https://auth.kimi.com/api/account.gateway.v1.AuthService/RefreshToken"
    kimiRefreshLeadTime  = 2 * time.Minute
    kimiRefreshRetryWait = 30 * time.Second
)

var (
    kimiTokenMu      sync.Mutex
    kimiRuntimeDir   = envOrDefault("KIMI_RUNTIME_DIR", "runtime/kimi")
    accessTokenFile  = envOrDefault("KIMI_ACCESS_TOKEN_FILE", filepath.Join(kimiRuntimeDir, "access_token"))
    refreshTokenFile = envOrDefault("KIMI_REFRESH_TOKEN_FILE", filepath.Join(kimiRuntimeDir, "refresh_token"))
    refreshToken     = readTokenFile(refreshTokenFile)
    kimiTimezone     = envOrDefault("KIMI_TIMEZONE", "America/Sao_Paulo")
)

type kimiJWTClaims struct {
    Exp      int64  `json:"exp"`
    Iat      int64  `json:"iat"`
    Typ      string `json:"typ"`
    Sub      string `json:"sub"`
    SSID     string `json:"ssid"`
    DeviceID string `json:"device_id"`
}

type kimiRefreshResponse struct {
    AccessToken  string `json:"accessToken"`
    RefreshToken string `json:"refreshToken"`
}

func readTokenFile(path string) string {
    data, err := os.ReadFile(path)
    if err != nil {
        return ""
    }
    return strings.TrimSpace(string(data))
}

func decodeKimiJWT(token string) (kimiJWTClaims, error) {
    var claims kimiJWTClaims
    parts := strings.Split(token, ".")
    if len(parts) != 3 {
        return claims, fmt.Errorf("invalid JWT segment count")
    }
    payload, err := base64.RawURLEncoding.DecodeString(parts[1])
    if err != nil {
        return claims, fmt.Errorf("decode JWT payload: %w", err)
    }
    if err := json.Unmarshal(payload, &claims); err != nil {
        return claims, fmt.Errorf("decode JWT claims: %w", err)
    }
    return claims, nil
}

func tokenNeedsRefresh(token string) bool {
    claims, err := decodeKimiJWT(token)
    if err != nil || claims.Typ != "access" || claims.Exp == 0 {
        return true
    }
    return time.Now().Add(kimiRefreshLeadTime).Unix() >= claims.Exp
}

func durationUntilRefresh(token string) time.Duration {
    claims, err := decodeKimiJWT(token)
    if err != nil || claims.Typ != "access" || claims.Exp == 0 {
        return 0
    }
    refreshAt := time.Unix(claims.Exp, 0).Add(-kimiRefreshLeadTime)
    wait := time.Until(refreshAt)
    if wait < 0 {
        return 0
    }
    return wait
}

func writeTokenAtomic(path, value string) error {
    dir := filepath.Dir(path)
    if err := os.MkdirAll(dir, 0700); err != nil {
        return err
    }
    tmp, err := os.CreateTemp(dir, ".kimi-token-*")
    if err != nil {
        return err
    }
    tmpName := tmp.Name()
    defer os.Remove(tmpName)
    if err := tmp.Chmod(0600); err != nil {
        tmp.Close()
        return err
    }
    if _, err := tmp.WriteString(value + "\n"); err != nil {
        tmp.Close()
        return err
    }
    if err := tmp.Sync(); err != nil {
        tmp.Close()
        return err
    }
    if err := tmp.Close(); err != nil {
        return err
    }
    return os.Rename(tmpName, path)
}

func refreshKimiTokenLocked() error {
    if refreshToken == "" {
        refreshToken = readTokenFile(refreshTokenFile)
    }
    if refreshToken == "" {
        return fmt.Errorf("missing Kimi refresh token file: %s", refreshTokenFile)
    }

    accessClaims, err := decodeKimiJWT(accessToken)
    if err != nil {
        return fmt.Errorf("decode current Kimi access token: %w", err)
    }
    refreshClaims, err := decodeKimiJWT(refreshToken)
    if err != nil {
        return fmt.Errorf("decode current Kimi refresh token: %w", err)
    }
    if refreshClaims.Typ != "refresh" {
        return fmt.Errorf("Kimi refresh credential has typ=%q, want refresh", refreshClaims.Typ)
    }
    if refreshClaims.Exp == 0 || time.Now().Unix() >= refreshClaims.Exp {
        return fmt.Errorf("Kimi refresh token is expired")
    }

    requestBody, err := json.Marshal(kimiRefreshResponse{AccessToken: accessToken, RefreshToken: refreshToken})
    if err != nil {
        return err
    }

    req, err := http.NewRequest(http.MethodPost, kimiRefreshURL, bytes.NewReader(requestBody))
    if err != nil {
        return err
    }
    req.Header.Set("Accept", "*/*")
    req.Header.Set("Connect-Protocol-Version", "1")
    req.Header.Set("Content-Type", "application/json")
    req.Header.Set("Origin", "https://www.kimi.com")
    req.Header.Set("Referer", "https://www.kimi.com/")
    req.Header.Set("R-Timezone", kimiTimezone)
    req.Header.Set("X-Msh-Device-Id", accessClaims.DeviceID)
    req.Header.Set("X-Msh-Platform", "web")
    req.Header.Set("X-Msh-Session-Id", accessClaims.SSID)
    req.Header.Set("X-Msh-Version", "2.0.0")
    req.Header.Set("X-Traffic-Id", accessClaims.Sub)

    resp, err := httpClient.Do(req)
    if err != nil {
        return fmt.Errorf("Kimi token refresh request: %w", err)
    }
    defer resp.Body.Close()
    if resp.StatusCode != http.StatusOK {
        body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
        return fmt.Errorf("Kimi token refresh HTTP %d: %s", resp.StatusCode, string(body))
    }

    var fresh kimiRefreshResponse
    if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&fresh); err != nil {
        return fmt.Errorf("decode Kimi token refresh response: %w", err)
    }
    if fresh.AccessToken == "" || fresh.RefreshToken == "" {
        return fmt.Errorf("Kimi token refresh response is missing accessToken or refreshToken")
    }

    newAccessClaims, err := decodeKimiJWT(fresh.AccessToken)
    if err != nil || newAccessClaims.Typ != "access" || newAccessClaims.Exp <= time.Now().Unix() {
        return fmt.Errorf("Kimi refresh returned an invalid access token")
    }
    newRefreshClaims, err := decodeKimiJWT(fresh.RefreshToken)
    if err != nil || newRefreshClaims.Typ != "refresh" || newRefreshClaims.Exp <= time.Now().Unix() {
        return fmt.Errorf("Kimi refresh returned an invalid refresh token")
    }

    if err := writeTokenAtomic(accessTokenFile, fresh.AccessToken); err != nil {
        return fmt.Errorf("persist Kimi access token: %w", err)
    }
    if err := writeTokenAtomic(refreshTokenFile, fresh.RefreshToken); err != nil {
        return fmt.Errorf("persist Kimi refresh token: %w", err)
    }

    accessToken = fresh.AccessToken
    refreshToken = fresh.RefreshToken
    log.Printf("Kimi access token refreshed; access expires %s, refresh expires %s",
        time.Unix(newAccessClaims.Exp, 0).Format(time.RFC3339),
        time.Unix(newRefreshClaims.Exp, 0).Format(time.RFC3339))
    return nil
}

// getAccessToken preserves the request-path guard. It shares the same mutex as
// the idle refresher, so a chat arriving at refresh time cannot race a scheduled
// refresh or cause two refresh requests.
func getAccessToken() string {
    kimiTokenMu.Lock()
    defer kimiTokenMu.Unlock()
    if tokenNeedsRefresh(accessToken) {
        if err := refreshKimiTokenLocked(); err != nil {
            log.Printf("Kimi access-token refresh failed: %v", err)
        }
    }
    return accessToken
}

// kimiTokenRefreshLoop keeps the access token alive even when the provider is
// idle. It sleeps until two minutes before the current token expiry, refreshes
// under the same lock used by request-time refresh, then recalculates from the
// newly issued token. Failures retry at a bounded interval and never busy-loop.
func kimiTokenRefreshLoop() {
    for {
        kimiTokenMu.Lock()
        wait := durationUntilRefresh(accessToken)
        kimiTokenMu.Unlock()

        if wait > 0 {
            time.Sleep(wait)
            continue
        }

        kimiTokenMu.Lock()
        if !tokenNeedsRefresh(accessToken) {
            kimiTokenMu.Unlock()
            continue
        }
        err := refreshKimiTokenLocked()
        kimiTokenMu.Unlock()
        if err != nil {
            log.Printf("Kimi background access-token refresh failed: %v; retrying in %s", err, kimiRefreshRetryWait)
            time.Sleep(kimiRefreshRetryWait)
        }
    }
}

func init() {
    go kimiTokenRefreshLoop()
}
