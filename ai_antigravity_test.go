package main

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

func TestParseAgyModels(t *testing.T) {
	out := "Fetching available models...\r\ngemini-3.8-flash-high\tGemini 3.8 Flash (High)\r\nclaude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\r\n\r\n"
	got := parseAgyModels(out)
	want := []string{"gemini-3.8-flash-high", "claude-sonnet-4-6"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("parseAgyModels = %v, want %v", got, want)
	}
	if parseAgyModels("Error: not signed in\n") != nil {
		t.Fatal("an error message must not become a model")
	}
}

// agyText joins the streamed reply chunks in ai:line output (live tests).
func agyText(lines string) string {
	var b strings.Builder
	for _, l := range strings.Split(lines, "\n") {
		var ev struct {
			Update struct {
				SessionUpdate string `json:"sessionUpdate"`
				Content       struct {
					Text string `json:"text"`
				} `json:"content"`
			} `json:"update"`
		}
		if json.Unmarshal([]byte(l), &ev) == nil && ev.Update.SessionUpdate == "agent_message_chunk" {
			b.WriteString(ev.Update.Content.Text)
		}
	}
	return b.String()
}
