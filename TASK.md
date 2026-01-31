# TASK

Project State Timeline

## What I Want To Implement First

This dashboard will eventually have many datapoints and visualizations, but we need to start somewhere - and this is what I believe would have the biggest positive impact as a "first" dashboard feature.

**Concept**: A highly stylized horizontal real-time graphical react component designed to show all agent activity, grouped by project, at a glance.

**Not Final** but here's a glimpse into my mind's eye for how I envision it:

- Each open `Session` is represented by a horizontal line, color-coded by project
- the X-axis is time of day.
- the default zoom level is 'Today' (24 hours) starting at 6am
- The orchestator agent for each session at the current time (marker) is represented by a filled circle.
- An agent actively orchestrating will have a pulsating circle
- An agent waiting for a response will have a solid, static circle with a `?` inside
- Drilling into an orchestror marker will show all direct reports (yi instances)
- Activity is shown by thickening of the opaque session line.
- Session completion is shown by 50% translucent normal-weighted session line

> Note: What is a Session
> A `Session` is a `Jelmore Session` which contains an `Agent Thread` aka `a bunch of prompts and responses` which are aimed at implementing a `Flume Task` aka `a ticket or dev story` which is claimed by a `Yi Node` aka `an agent` aka `an employee` which lives as a node on a `Flume Tree` aka the `corporate hierarchy` implementation which divides all resources (agents/employees/Yi instances) into domain-specific teams that model real-world cross-functional teams.
