package main

import "golang.org/x/sys/windows"

// knownDownloadsDir returns the Downloads folder even when the user moved it.
func knownDownloadsDir() string {
	d, err := windows.KnownFolderPath(windows.FOLDERID_Downloads, 0)
	if err != nil || !dirExists(d) {
		return ""
	}
	return d
}
