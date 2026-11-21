# Release storage and retention

## Inventory on 2026-11-21

| Measurement | Result |
| --- | ---: |
| R2 Standard storage | 9,279,094,080 bytes in 77 objects |
| Registered stable release installers present | 76 |
| Registry rows with a missing installer | 0 |
| Active release and five newest prior releases | 799,842,928 bytes in six objects |
| Superseded registered releases older than 90 days | 0 |
| Unregistered installer | 113,835,490 bytes in one object |

The unregistered object is `releases/0.3.1/11/Private-Browser-0.3.1-Setup.exe`.
R2 reports it was uploaded on 2026-09-10. It has no release registry row, so
the activation route cannot use it for rollback. Removing it would reclaim
113,835,490 bytes. This inventory made no cloud changes.

For the 30 days ending 2026-11-21 at 22:44 UTC, the bucket reported 833 requests.
These included 420 object checks, 270 object reads, 107 bucket checks, 35 object
writes and one lifecycle configuration read. [Cloudflare R2 metrics](https://developers.cloudflare.com/r2/platform/metrics-analytics/)

The most recent 15 completed verification workflow runs sampled at 22:26 UTC
included 51.9 Linux runner minutes and 86.1 Windows runner minutes. The jobs
used standard GitHub-hosted runners on a public repository. [GitHub Actions billing](https://docs.github.com/en/actions/concepts/billing-and-usage)

## Retention review

- Keep the active release and the five most recent prior publications in each
  channel. Preserve any separately designated recovery build. Protect their
  checksums, publisher records and other release sidecars together.
- Keep superseded registered releases for at least 90 days. Check that the
  current installer and retained recovery installers exist and match their
  recorded size and checksum before proposing any removals.
- Review unregistered objects after seven days. Exclude sidecars of registered
  versions, objects involved in an open publication or retry, and objects
  whose ownership is uncertain. The existing R2 rule already stops incomplete
  multipart uploads after seven days.
- Compare a current R2 list with the D1 registry and inspect the CI runs before
  each cleanup. Ask the owner to approve the exact keys, counts and bytes.
  Recheck approval, active release and object metadata before removing a key.
  Select individual objects because active and retained builds share the
  `releases/` prefix.
- Verify R2 health and the full checksum of the current release after cleanup.
  Review measured storage and operation totals before changing the policy.
