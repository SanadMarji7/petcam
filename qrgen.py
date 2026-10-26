"""Real QR codes for the pairing links, rendered as SVG (web) or text (terminal).

The matrix comes from the `qrcode` package; this module only draws it. Both
renderers keep the 4-module quiet zone the QR spec requires so phone cameras
lock on quickly.
"""
from __future__ import annotations

import qrcode
import qrcode.constants

Matrix = list[list[bool]]

QUIET_ZONE_MODULES = 4


def qr_matrix(data: str) -> Matrix:
    """Modules of a QR code for `data`, including the quiet zone."""
    qr = qrcode.QRCode(
        error_correction=qrcode.constants.ERROR_CORRECT_M,
        border=QUIET_ZONE_MODULES,
    )
    qr.add_data(data)
    qr.make(fit=True)
    return [[bool(cell) for cell in row] for row in qr.get_matrix()]


def matrix_to_svg(matrix: Matrix, size_px: int = 256) -> str:
    """A crisp, self-contained SVG. Dark modules are one <path> for a tiny file."""
    modules = len(matrix)
    segments: list[str] = []
    for y, row in enumerate(matrix):
        x = 0
        while x < modules:
            if row[x]:
                run_start = x
                while x < modules and row[x]:
                    x += 1
                segments.append(f"M{run_start} {y}h{x - run_start}v1h-{x - run_start}z")
            else:
                x += 1
    path = "".join(segments)
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {modules} {modules}" '
        f'width="{size_px}" height="{size_px}" shape-rendering="crispEdges" role="img" '
        f'aria-label="QR code">'
        f'<rect width="{modules}" height="{modules}" fill="#ffffff"/>'
        f'<path d="{path}" fill="#000000"/>'
        f"</svg>"
    )


def qr_svg(data: str, size_px: int = 256) -> str:
    return matrix_to_svg(qr_matrix(data), size_px)


def matrix_to_terminal(matrix: Matrix) -> str:
    """Half-block rendering: each character shows two vertically stacked modules.

    Printed on a white background with black modules so camera apps see the
    normal polarity even on dark terminal themes.
    """
    white_bg_black_fg = "\033[47;30m"
    reset = "\033[0m"
    width = len(matrix[0])
    lines: list[str] = []
    for y in range(0, len(matrix), 2):
        top = matrix[y]
        bottom = matrix[y + 1] if y + 1 < len(matrix) else [False] * width
        cells = []
        for x in range(width):
            if top[x] and bottom[x]:
                cells.append("█")
            elif top[x]:
                cells.append("▀")
            elif bottom[x]:
                cells.append("▄")
            else:
                cells.append(" ")
        lines.append(white_bg_black_fg + "".join(cells) + reset)
    return "\n".join(lines)
