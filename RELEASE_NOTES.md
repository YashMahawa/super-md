# Super MD 0.6.3

## Component-level theme controls

- Style Python source, headers, Run buttons, output and errors separately from ordinary code blocks.
- Give tables their own body, header, borders, alternating rows and hover colours. Tune cell padding and header weight independently.
- Customize inline code, syntax categories, ordinary blockquotes and callout bodies, plus bounded component-specific corners and borders.
- Text and syntax contrast are checked against each component's actual surface. Dark Python cells can coexist with light code blocks.
- The same portable JSON works on desktop and Android. Palette changes retain existing math nodes, reading position and zoom; Reset removes all overrides.
- New Study desk and Lazy Sunday cats examples, a complete authoring reference, and a README showcase of three user-selected character themes. Third-party artwork shown in screenshots is not bundled as a reusable theme.

## Updates that stay downloaded

- Verified installers are saved in Downloads and remembered between launches. Repeated checks reuse an existing download; missing or modified files are refused.
- Portable Linux updates install side-by-side and activate the managed launcher for the next launch instead of starting a competing AppImage. Existing windows, notes, downloads and previous installations are kept.
- Windows and macOS retain their normal installer approval; DEB/RPM installations remain owned by the system package manager.
- Android stages a verified, signed release APK in private storage and also publishes it to Downloads. It restores a ready download offline after restart.
- Android removes only its owned installer copies after observing a successful upgrade on a later launch. Cancelling installation does not delete the APK. Desktop downloads are never automatically deleted.

## Experimental AppImage integration

- Portable Linux onboarding and Settings offer an off-by-default Add to Applications option.
- Registration creates a per-user launcher, icon and Open With entries without changing file defaults or replacing unrelated launchers.
- Moving the original download does not break the managed launcher. Turning registration off does not uninstall an existing entry.
- Package-managed Linux installations do not show this option.

## Verification and compatibility

- A delayed native zoom command can no longer overwrite a newer pinch gesture. New gestures also cancel stale glide acknowledgements, preventing snap-back on Android and desktop.
- Component import/share round trips, bounds, injection rejection, actual reader styling and document-node retention have regression coverage.
- Updater tests cover offline persistence, tampering, download reuse, launcher activation, rollback preservation and Android success/cancellation cleanup.
- Releases remain gated on cross-platform CI, signed Android APK validation and complete installer checks.
- Existing themes remain valid. New component roles require 0.6.3 or newer; older builds reject unsupported fields without replacing the last valid theme.
- macOS packages remain ad-hoc signed rather than notarized. Windows installers are not code-signed.
