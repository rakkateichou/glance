package glance

import (
	"encoding/json"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sync"

	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

type SyncMessage struct {
	Key   string `json:"key"`
	Value string `json:"value"`
}

type syncStore struct {
	mu      sync.Mutex
	data    map[string]string
	clients map[*websocket.Conn]bool
	file    string
}

var globalSyncStore = &syncStore{
	data:    make(map[string]string),
	clients: make(map[*websocket.Conn]bool),
	file:    "data/sync_data.json",
}

func (s *syncStore) load() {
	s.mu.Lock()
	defer s.mu.Unlock()

	os.MkdirAll(filepath.Dir(s.file), os.ModePerm)
	data, err := os.ReadFile(s.file)
	if err == nil {
		json.Unmarshal(data, &s.data)
	}
}

func (s *syncStore) save() {
	// Assumes caller holds mu or it's safe to read data
	data, _ := json.MarshalIndent(s.data, "", "  ")
	os.WriteFile(s.file, data, 0644)
}

func (a *application) handleSyncWebSocket(w http.ResponseWriter, r *http.Request) {
	ws, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Println("Upgrade error:", err)
		return
	}
	defer ws.Close()

	s := globalSyncStore
	s.mu.Lock()
	s.clients[ws] = true
	// Send current state
	for k, v := range s.data {
		ws.WriteJSON(SyncMessage{Key: k, Value: v})
	}
	s.mu.Unlock()

	for {
		var msg SyncMessage
		err := ws.ReadJSON(&msg)
		if err != nil {
			s.mu.Lock()
			delete(s.clients, ws)
			s.mu.Unlock()
			break
		}

		s.mu.Lock()
		s.data[msg.Key] = msg.Value
		s.save()
		// Broadcast
		for client := range s.clients {
			if client != ws {
				client.WriteJSON(msg)
			}
		}
		s.mu.Unlock()
	}
}
