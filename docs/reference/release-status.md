# Private Browser release status

In GitHub Actions, select **Check release status** and then **Run workflow**.
Open the completed job summary to see the active installer version, build,
source revision and manifest age. The download check reads the first two bytes
and verifies the size advertised by the active object.

The report links recent installer CI and the manual Worker deployment workflow
separately. Worker health describes production. A GitHub workflow link describes
that run. The check performs public reads and does not change the active release.
