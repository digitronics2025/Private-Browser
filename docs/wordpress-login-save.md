# Save WordPress logins in MyVault

On a supported HTTPS WordPress sign-in or profile page, open **Site information**
and turn on **Offer to save WordPress logins**. This applies to that full origin
in the current Account Space. MyVault must be unlocked to offer a save.

Private Browser checks that you submitted the standard WordPress form, that the
site issued secure authentication cookies, and that the corresponding account
page loaded. Then choose **Save login**, **Update login**, **Not now**, or **Never
on this site**. A short-lived candidate stays in memory until the decision.
Private Browser saves only after approval through the native prompt. [WordPress sign-in](https://developer.wordpress.org/reference/functions/wp_signon/) · [WordPress auth cookies](https://developer.wordpress.org/reference/functions/wp_set_auth_cookie/)

Banking and Development do not capture passwords. Custom sign-in plugins, SSO,
password resets, redirects outside the site, and profiles without the standard
change-password form leave the manual MyVault workflow available.
