package main

import (
	"context"
	_ "embed"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"
)

// donors.json lists where to donate and the people who did. The app reads the
// current file from GitHub each time the Donate tab opens, so a new donor shows
// up without a new release. Donor names are never kept in the app: the copy
// built in only supplies the donation links when GitHub cannot be reached.
//
//go:embed donors.json
var donorsEmbedded []byte

const donorsURL = "https://raw.githubusercontent.com/" + updateRepo + "/main/donors.json"

type DonateLink struct {
	Name string `json:"name"`
	URL  string `json:"url"`
}

type Donor struct {
	Name string `json:"name"`
	Note string `json:"note,omitempty"` // optional, e.g. a short message
	Date string `json:"date,omitempty"` // optional, e.g. "2026-11"
}

type DonorInfo struct {
	Links  []DonateLink `json:"links"`
	Donors []Donor      `json:"donors"`
	Online bool         `json:"online"` // false: GitHub unreachable, donor list unknown
}

func parseDonors(data []byte) (DonorInfo, bool) {
	var d DonorInfo
	if json.Unmarshal(data, &d) != nil {
		return DonorInfo{}, false
	}
	links := d.Links[:0]
	for _, l := range d.Links { // only plain web links are shown
		if strings.HasPrefix(l.URL, "https://") && l.Name != "" {
			links = append(links, l)
		}
	}
	d.Links = links
	if d.Donors == nil {
		d.Donors = []Donor{}
	}
	return d, true
}

// GetDonors returns the donation links and donors, from GitHub when possible.
func (a *App) GetDonors() DonorInfo {
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	if req, err := http.NewRequestWithContext(ctx, "GET", donorsURL, nil); err == nil {
		if resp, err := http.DefaultClient.Do(req); err == nil {
			data, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
			resp.Body.Close()
			if resp.StatusCode == 200 {
				if d, ok := parseDonors(data); ok {
					d.Online = true
					return d
				}
			}
		}
	}
	d, _ := parseDonors(donorsEmbedded)
	d.Donors = []Donor{}
	return d
}
