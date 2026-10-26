from __future__ import annotations

import re

import qrcode

from qrgen import QUIET_ZONE_MODULES, matrix_to_svg, matrix_to_terminal, qr_matrix, qr_svg

URL = "https://dogcam.tail1234.ts.net/watch#key=" + "k" * 43


def test_matrix_is_square_with_quiet_zone() -> None:
    m = qr_matrix(URL)
    assert len(m) == len(m[0])
    assert all(len(row) == len(m) for row in m)
    # Quiet zone rows/columns are all white.
    assert not any(m[0]) and not any(m[QUIET_ZONE_MODULES - 1])
    assert not any(row[0] for row in m)
    # Finder pattern starts right after the quiet zone.
    assert all(m[QUIET_ZONE_MODULES][QUIET_ZONE_MODULES + i] for i in range(7))
    assert m == qr_matrix(URL)


def test_matrix_matches_library_rendering() -> None:
    qr = qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_M, border=QUIET_ZONE_MODULES)
    qr.add_data(URL)
    qr.make(fit=True)
    assert qr_matrix(URL) == [[bool(c) for c in row] for row in qr.get_matrix()]


def test_svg_output() -> None:
    svg = qr_svg(URL, size_px=200)
    assert svg.startswith("<svg") and svg.endswith("</svg>")
    assert 'width="200" height="200"' in svg
    n = len(qr_matrix(URL))
    assert f'viewBox="0 0 {n} {n}"' in svg
    # One rectangle per horizontal run of dark modules.
    m = qr_matrix(URL)
    runs = sum(len(re.findall(r"1+", "".join("1" if c else "0" for c in row))) for row in m)
    assert svg.count("M") == runs
    assert "<" not in svg.split('d="', 1)[1].split('"', 1)[0]


def test_svg_handles_tiny_matrix() -> None:
    assert "<path" in matrix_to_svg([[True, False], [False, True]], 10)


def test_terminal_rendering() -> None:
    m = qr_matrix(URL)
    text = matrix_to_terminal(m)
    lines = text.split("\n")
    assert len(lines) == (len(m) + 1) // 2
    assert all(line.startswith("\033[47;30m") and line.endswith("\033[0m") for line in lines)
    assert "█" in text and "▀" in text and "▄" in text
