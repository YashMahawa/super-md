# Super MD desktop distribution notices

Super MD's original code is licensed under the MIT License. Its complete
copyright and license notice is included in LICENSE with this package.
The following third-party components retain their own notices and licenses.

HTTPS clients include certifi's unmodified Mozilla CA certificate bundle
(MPL-2.0), alongside operating-system trust. The certifi license is included
under resources/licenses/certifi. Source: https://github.com/certifi/python-certifi

The desktop package uses unmodified PySide6 / Qt 6.11.2 dynamically linked
libraries, Python, NumPy, Material Color Utilities and the bundled Rust/Typst
PDF engine. Qt is available under LGPLv3/GPLv3 and commercial terms; this
distribution uses the applicable open-source terms. The libraries remain
separate in the `_internal` directory and may be replaced with compatible
modified builds. This package does not prohibit reverse engineering for
debugging modifications to LGPL components.

Qt/PySide source and licensing:

- https://download.qt.io/official_releases/QtForPython/pyside6/
- https://code.qt.io/cgit/pyside/pyside-setup.git/
- https://code.qt.io/cgit/qt/
- https://doc.qt.io/qt-6/qtwebengine-licensing.html
- https://www.gnu.org/licenses/lgpl-3.0.html

The package contains the license files supplied with the redistributed wheels
and the existing third-party UI notices. NumPy wheel licenses are retained by
the PyInstaller NumPy hook. The QML controls are independently implemented;
desktop-shell reference code is not included.

The SVG toolbar/navigation icons in desktop/icons are unmodified Google Material
Symbols Rounded, weight 600 (Apache-2.0), downloaded from google/material-design-icons commit
737e3324305806514d7909874fa1818ae1808232. Their license is bundled in
licenses/qt/Material-Symbols-Apache-2.0.txt.
Source: https://github.com/google/material-design-icons/tree/737e3324305806514d7909874fa1818ae1808232/symbols/web

Android uses the same path geometry converted to VectorDrawable XML with a
viewBox translation. Its distribution includes the same Apache-2.0 license.

Android's optional theme artwork renderer uses AndroidSVG 1.4 (Apache-2.0),
Copyright 2013–2018 Cave Rock Software Ltd.
Source: https://github.com/BigBadaboom/androidsvg
Its Apache-2.0 terms are included in the Android package's assets/licenses.
