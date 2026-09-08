"""Read-only live observer for Agent Lord native exec operations.

This package never mutates dispatch state: it only reads task, operation,
event-journal, and provider stdout files and projects them into sanitized
display events served over loopback HTTP (snapshot + cursor + SSE).
"""
