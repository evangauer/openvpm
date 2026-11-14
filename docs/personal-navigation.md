# Personal sidebar choices

The sidebar starts in **Full navigation** for every new account. Open **All tools**
to choose **Focused navigation** and pin the tools you use most. These choices
belong to your teammate account in the current clinic. They do not change other
teammates' sidebars or grant access to tools outside your role.

Signed-in devices load the same saved layout and pins. Changes made elsewhere
are refreshed when you return to the window, reconnect, or within 30 seconds
while the page is visible. Pin edits and layout edits are saved independently,
so changing a pin on one device does not overwrite a layout change on another.
For conflicting edits to the same choice, the last server-applied edit wins.

If the account has no saved preference yet, the first device with existing
browser preferences imports them. Later devices use the account's choices. The
original browser preference entry remains intact for rollback. The earlier
pin-only preview is imported as an explicit Focused choice; untouched accounts
remain Full.

When a connection fails, pending choices stay in this browser and retry on
reconnect or return to the page. A warning appears when sync is unavailable.
If browser storage is blocked, current-session changes can still sync to the
account, but unsent changes cannot survive closing the page. Keep it open until
connected. Viewers can save their own navigation choices; their clinical and
administrative permissions remain read-only.

Deploy the additive `users.sidebar_preferences` migration before the new app.
The nullable column is compatible with previous app versions. Do not remove it
on artifact rollback or rewrite historical migrations. New app versions retain
v1 browser storage and use a separate v2 cache for retry state.
