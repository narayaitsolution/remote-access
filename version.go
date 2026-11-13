package main

// appVersion follows the project's scheme: the MAJOR number goes up for every
// new feature, the MINOR number for fixes, small changes and documentation.
// The full history is in README.md ("Version history").
const appVersion = "8.1"

// GetVersion returns the application version for display in the UI.
func (a *App) GetVersion() string { return appVersion }
