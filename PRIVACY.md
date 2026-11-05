# Northstar privacy policy

_Last updated: 3 November 2026_

**Short version:** Northstar collects nothing about you. There are no accounts, no analytics, no crash reports and no telemetry, and the developer runs no servers that receive your data. What you browse stays on your computer. Some features contact other services, the way any browser does. They are listed below, with how to turn them off.

## What stays on your computer

Your history, bookmarks, saved passwords, open tabs, settings, site permissions and cookies are stored only on your device, in your Northstar profile folder. Passwords, history, bookmarks, tabs and settings are encrypted at rest (AES-256-GCM), with the key protected by your operating system's secure store where one is available. You can clear this data at any time in **Settings › Privacy › Clear browsing data**. You can also export your history, bookmarks and passwords from **Settings › Import & export**.

**Private windows** keep nothing. They aren't saved to history or your session, send no search suggestions, fetch no remote site icons, and their cookies and storage are wiped when the window closes.

## What your browser sends, and to whom

These connections come from Northstar itself, not from the websites you visit.

| Feature | Sent to | What is sent | When | How to turn it off |
|---|---|---|---|---|
| Search suggestions | Your search engine (Google by default, or DuckDuckGo or Bing) | What you type in the address bar | As you type | **Settings › Privacy › Search suggestions** |
| Searches | Your search engine | Your search | When you search | Choose your engine in **Settings › Search** |
| Site icons in suggestions | Google's or DuckDuckGo's icon service | The domain of a suggested site you haven't visited | As you type | Turn off search suggestions |
| Faster loading | Sites you hover over or start typing | An early connection (your IP address) | Before you click | — |
| Update checks | GitHub (where Northstar is published) | Your IP address and Northstar's version | At launch, then every 4 hours | **Settings › About › Update automatically** |
| Ad and tracker lists | easylist.to, jsDelivr | Your IP address | About every 3 days | Turn off **Ad & tracker blocking** |
| Network login check | detectportal.firefox.com | Your IP address | When your network changes | — |
| Protected video (DRM) | The video service's licence server, via the Widevine module | Device identifiers the DRM system requires | Only when you play protected video | — |
| Extensions | Chrome Web Store (Google) | The extension's ID and version | When you install or update an extension | Don't install extensions |

Each of these services handles your data under its own privacy policy.

## Signals Northstar sends to websites

Northstar sends **Global Privacy Control** and **Do Not Track** to every site by default. In some places, such as California, GPC is a legally recognised request not to sell or share your data. Turn it off in **Settings › Privacy**. Northstar also blocks third-party cookies, strips tracking parameters from links and trims referrer information by default.

## Children

Northstar is a general-purpose browser. It collects no data from anyone, children included.

## Changes

If this policy changes, the new version is published here and the date above is updated.

## Contact

Questions: open an issue at <https://github.com/Milad-exe/The-Northstar-Browser/issues>.
