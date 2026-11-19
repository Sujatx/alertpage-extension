# Updating the AlertPage extension

## One-time setup (the last manual install)

1. In Chrome, go to `chrome://extensions`, find **AlertPage Working Screen Assist**, click **Details**, and read **Loaded from**. That folder is the one Chrome is using. Do not delete it.
2. Delete every old zip file and every other extracted copy of the extension (Downloads, Desktop, etc.).
3. Move that one folder to `C:\AlertPage\extension`. Only if you moved it:
   - In `chrome://extensions`, remove the old entry, then click **Load unpacked** and pick `C:\AlertPage\extension`.
   - **Warning:** moving changes the folder path, so Chrome treats it as a new extension and your settings reset once. Open the extension popup and type your ID in the **Your ID** field again (one time only).
4. Put `Update AlertPage.bat` and `update-alertpage.ps1` in `C:\AlertPage`, next to the `extension` folder, not inside it.

## How to update

1. Double-click `Update AlertPage.bat`.
2. Wait until it says **Now click the reload button on the AlertPage extension**.
3. Open `chrome://extensions` and click the reload arrow on **AlertPage Working Screen Assist**.
4. Reload the AlertPage tab.

If Windows says "Windows protected your PC" (SmartScreen), click **More info**, then **Run anyway**.

If the window shows an error in red, nothing was changed. Check your internet and try again.

## Rollback

The updater always installs the newest release. To go back: download the previous release's zip from the repo's Releases page (github.com/Sujatx/alertpage-extension/releases), unzip it, replace everything inside `C:\AlertPage\extension` with the unzipped files, and click reload on the extension. Or ask the maintainer to re-publish the previous version as the latest release, then run the updater.

## For the maintainer: publishing a release

1. Bump `version` in `extension/manifest.json`, then run `node tools/build-release.mjs`.
2. Create a GitHub release on `Sujatx/alertpage-extension`, mark it **Latest**.
3. Attach both files from `dist/`, with exactly these names: `alertpage-extension.zip` and `alertpage-extension.zip.sha256`.
