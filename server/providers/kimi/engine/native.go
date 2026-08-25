package main

import (
    "bytes"
    "encoding/json"
    "fmt"
    "io"
    "net/http"
    "net/url"
    "strings"
)

const (
    kimiProjectService = "https://www.kimi.com/apiv2/kimi.gateway.project.v1.ProjectService/"
    kimiChatService    = "https://www.kimi.com/apiv2/kimi.gateway.chat.v1.ChatService/"
)

func kimiNativeHeaders(req *http.Request) {
    token := getAccessToken()
    claims, _ := decodeKimiJWT(token)

    req.Header.Set("Accept", "application/json")
    req.Header.Set("Authorization", "Bearer "+token)
    req.Header.Set("Connect-Protocol-Version", "1")
    req.Header.Set("Content-Type", "application/json")
    req.Header.Set("Origin", "https://www.kimi.com")
    req.Header.Set("Referer", "https://www.kimi.com/")
    req.Header.Set("R-Timezone", kimiTimezone)
    req.Header.Set("X-Msh-Platform", "web")
    req.Header.Set("X-Msh-Version", "2.0.0")
    if claims.DeviceID != "" {
        req.Header.Set("X-Msh-Device-Id", claims.DeviceID)
    }
    if claims.SSID != "" {
        req.Header.Set("X-Msh-Session-Id", claims.SSID)
    }
    if claims.Sub != "" {
        req.Header.Set("X-Traffic-Id", claims.Sub)
    }
}

func kimiNativeRPC(endpoint string, payload map[string]interface{}) (map[string]interface{}, int, error) {
    if payload == nil {
        payload = map[string]interface{}{}
    }
    body, err := json.Marshal(payload)
    if err != nil {
        return nil, 0, err
    }
    req, err := http.NewRequest(http.MethodPost, endpoint, bytes.NewReader(body))
    if err != nil {
        return nil, 0, err
    }
    kimiNativeHeaders(req)

    resp, err := httpClient.Do(req)
    if err != nil {
        return nil, 0, err
    }
    defer resp.Body.Close()

    raw, err := io.ReadAll(io.LimitReader(resp.Body, 16<<20))
    if err != nil {
        return nil, resp.StatusCode, err
    }
    var result map[string]interface{}
    if len(raw) == 0 {
        result = map[string]interface{}{}
    } else if err := json.Unmarshal(raw, &result); err != nil {
        return map[string]interface{}{"raw": string(raw)}, resp.StatusCode, fmt.Errorf("decode Kimi native response: %w", err)
    }
    if resp.StatusCode < 200 || resp.StatusCode >= 300 {
        return result, resp.StatusCode, fmt.Errorf("Kimi native HTTP %d", resp.StatusCode)
    }
    return result, resp.StatusCode, nil
}

func copyJSONBody(r *http.Request) (map[string]interface{}, error) {
    if r.Body == nil {
        return map[string]interface{}{}, nil
    }
    defer r.Body.Close()
    dec := json.NewDecoder(io.LimitReader(r.Body, 2<<20))
    var payload map[string]interface{}
    if err := dec.Decode(&payload); err != nil {
        if err == io.EOF {
            return map[string]interface{}{}, nil
        }
        return nil, err
    }
    if payload == nil {
        payload = map[string]interface{}{}
    }
    return payload, nil
}

func firstQuery(q url.Values, names ...string) string {
    for _, name := range names {
        if value := strings.TrimSpace(q.Get(name)); value != "" {
            return value
        }
    }
    return ""
}

func writeKimiNative(w http.ResponseWriter, endpoint string, payload map[string]interface{}) {
    result, status, err := kimiNativeRPC(endpoint, payload)
    if err != nil {
        if status == 0 {
            status = http.StatusBadGateway
        }
        sendJSON(w, map[string]interface{}{
            "error": map[string]interface{}{
                "message": err.Error(),
                "type":    "provider_error",
                "code":    "kimi_native_error",
            },
            "upstream": result,
        }, status)
        return
    }
    sendJSON(w, result, http.StatusOK)
}

func handleKimiNativeRoute(w http.ResponseWriter, r *http.Request) bool {
    path := strings.TrimSuffix(r.URL.Path, "/")

    if path == "/v1/projects" && r.Method == http.MethodGet {
        writeKimiNative(w, kimiProjectService+"ListProjects", map[string]interface{}{})
        return true
    }

    if path == "/v1/conversations" && r.Method == http.MethodGet {
        payload := map[string]interface{}{}
        if projectID := firstQuery(r.URL.Query(), "project_id", "projectId"); projectID != "" {
            payload["projectId"] = projectID
        }
        writeKimiNative(w, kimiChatService+"ListChats", payload)
        return true
    }

    if strings.HasPrefix(path, "/v1/projects/") {
        rest := strings.TrimPrefix(path, "/v1/projects/")
        parts := strings.Split(rest, "/")
        projectID, _ := url.PathUnescape(parts[0])
        if projectID == "" {
            return false
        }

        if len(parts) == 1 && r.Method == http.MethodGet {
            writeKimiNative(w, kimiProjectService+"GetProject", map[string]interface{}{"projectId": projectID})
            return true
        }
        if len(parts) == 2 && parts[1] == "files" && r.Method == http.MethodGet {
            writeKimiNative(w, kimiProjectService+"ListProjectFiles", map[string]interface{}{"projectId": projectID})
            return true
        }
        if len(parts) == 2 && parts[1] == "conversations" && r.Method == http.MethodGet {
            writeKimiNative(w, kimiChatService+"ListChats", map[string]interface{}{"projectId": projectID})
            return true
        }
        if len(parts) == 2 && parts[1] == "conversations" && r.Method == http.MethodPost {
            payload, err := copyJSONBody(r)
            if err != nil {
                sendError(w, "Invalid JSON body", "invalid_request_error", "invalid_json", http.StatusBadRequest)
                return true
            }
            payload["projectId"] = projectID
            writeKimiNative(w, kimiChatService+"CreateChat", payload)
            return true
        }
    }

    if strings.HasPrefix(path, "/v1/conversations/") {
        rest := strings.TrimPrefix(path, "/v1/conversations/")
        parts := strings.Split(rest, "/")
        chatID, _ := url.PathUnescape(parts[0])
        if chatID == "" {
            return false
        }
        if len(parts) == 1 && r.Method == http.MethodGet {
            writeKimiNative(w, kimiChatService+"GetChat", map[string]interface{}{"chatId": chatID})
            return true
        }
        if len(parts) == 2 && parts[1] == "messages" && r.Method == http.MethodGet {
            writeKimiNative(w, kimiChatService+"ListMessages", map[string]interface{}{"chatId": chatID})
            return true
        }
        if len(parts) == 2 && parts[1] == "resume" && r.Method == http.MethodPost {
            payload, err := copyJSONBody(r)
            if err != nil {
                sendError(w, "Invalid JSON body", "invalid_request_error", "invalid_json", http.StatusBadRequest)
                return true
            }
            payload["chatId"] = chatID
            writeKimiNative(w, kimiChatService+"ResumeChat", payload)
            return true
        }
    }

    return false
}
