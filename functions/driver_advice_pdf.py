"""Generates one branded PDF per 1099 driver ("Driver Payment Advice"),
built from the same numbers already shown on the Payroll Report's "Driver
Payroll (1099s) Recap" sheet (Tips / Deliveries $ / Setups $ / Total).

Added 9/16/2026 (per Guapo) -- see the "1099 driver payment advice PDFs"
section of the project notes for the full design history. This module is
ONLY the PDF-rendering piece; it takes plain numbers in and PDF bytes out,
same separation-of-concerns pattern as report_builder.py.

Branding: GFG navy #2B3C5E (Pantone 288) per the company style guide,
Montserrat typeface (the same practical choice already made for the web
app's own UI -- see "Tabbed UI + Gourmet for Good branding" in project
notes). Montserrat isn't a built-in PDF font, so static Regular/Bold TTF
instances are bundled in functions/fonts/ and registered with reportlab
at import time.

Logo: Guapo supplied the real GFG mark 9/16/2026 (the circular "g/g" +
fork icon above the "gourmet for good" wordmark) -- functions/logo/
gfg_icon_white.png is that icon, cropped to just the circular mark and
recolored so the disc renders white with the g/g+fork cut out in
whatever sits behind it (navy, here) -- a standard reversed/single-color
treatment for placing a mostly-dark mark on a dark band, not an
alteration of the artwork itself. Placed to the left of the "Gourmet for
Good®" text per Guapo's direction. The ® mark on the text is per Guapo's
standing preference (the supplied artwork already carries its own ®
next to the wordmark, so both are represented).
"""

import io
import os
from datetime import datetime

from reportlab.lib import colors
from reportlab.lib.pagesizes import LETTER
from reportlab.lib.units import inch
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer, Flowable,
)

GFG_NAVY = colors.HexColor("#2B3C5E")
GFG_NAVY_LIGHT = colors.HexColor("#EEF1F6")
GFG_GRAY = colors.HexColor("#6B7280")

_FONTS_DIR = os.path.join(os.path.dirname(__file__), "fonts")
_FONTS_REGISTERED = False
_LOGO_PATH = os.path.join(os.path.dirname(__file__), "logo", "gfg_icon_white.png")
_LOGO_READER = None


def _get_logo_reader():
    global _LOGO_READER
    if _LOGO_READER is None:
        _LOGO_READER = ImageReader(_LOGO_PATH)
    return _LOGO_READER


def _register_fonts():
    """Idempotent -- Cloud Functions can reuse a warm instance across
    invocations, and re-registering the same font name raises."""
    global _FONTS_REGISTERED
    if _FONTS_REGISTERED:
        return
    pdfmetrics.registerFont(TTFont("Montserrat", os.path.join(_FONTS_DIR, "Montserrat-Regular.ttf")))
    pdfmetrics.registerFont(TTFont("Montserrat-Bold", os.path.join(_FONTS_DIR, "Montserrat-Bold.ttf")))
    _FONTS_REGISTERED = True


class _NavyHeaderBand(Flowable):
    """The navy header band with the GFG wordmark, drawn as a flowable so
    it sits inline in the Platypus story (simpler than a page template for
    a single-page document)."""

    def __init__(self, width, height=1.15 * inch):
        Flowable.__init__(self)
        self.width = width
        self.height = height

    def draw(self):
        c = self.canv
        c.setFillColor(GFG_NAVY)
        c.rect(0, 0, self.width, self.height, stroke=0, fill=1)

        # Logo icon, left-aligned and vertically centered in the band.
        logo = _get_logo_reader()
        logo_w, logo_h = logo.getSize()
        icon_h = 0.8 * inch
        icon_w = icon_h * (logo_w / logo_h)
        icon_x = 0.4 * inch
        icon_y = (self.height - icon_h) / 2
        c.drawImage(logo, icon_x, icon_y, width=icon_w, height=icon_h, mask="auto")

        # Wordmark + subtitle, to the right of the icon.
        text_x = icon_x + icon_w + 0.25 * inch
        c.setFillColor(colors.white)
        c.setFont("Montserrat-Bold", 20)
        c.drawString(text_x, self.height - 0.48 * inch, "Gourmet for Good®")
        c.setFont("Montserrat", 11)
        c.drawString(text_x, self.height - 0.78 * inch, "Driver Payment Advice")


def _currency(value):
    value = float(value or 0)
    sign = "-" if value < 0 else ""
    return f"{sign}${abs(value):,.2f}"


def _fmt_pay_date(pay_period_id):
    """pay_period_id is 'YYYY-MM-DD'; render it the way a human reads a
    pay date on a check stub."""
    try:
        return datetime.strptime(pay_period_id, "%Y-%m-%d").strftime("%B %-d, %Y")
    except ValueError:
        return pay_period_id


def build_driver_advice_pdf(driver_name, pay_period_id, tips, deliveries, setups,
                             review_email="getinfo@gourmetforgood.com"):
    """Returns PDF bytes for one driver's payment advice.

    tips/deliveries/setups are dollar totals (not counts) -- same meaning
    as the "Driver Payroll (1099s) Recap" sheet's columns. Total is
    computed here, never passed in, so it can never drift from the sum.
    """
    _register_fonts()

    tips = round(float(tips or 0), 2)
    deliveries = round(float(deliveries or 0), 2)
    setups = round(float(setups or 0), 2)
    total = round(tips + deliveries + setups, 2)

    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf, pagesize=LETTER,
        leftMargin=0, rightMargin=0, topMargin=0, bottomMargin=0.75 * inch,
    )
    page_width = LETTER[0]

    label_style = ParagraphStyle(
        "label", fontName="Montserrat", fontSize=10, textColor=GFG_GRAY, leading=13,
    )
    value_style = ParagraphStyle(
        "value", fontName="Montserrat-Bold", fontSize=13, textColor=GFG_NAVY, leading=16,
    )
    footer_style = ParagraphStyle(
        "footer", fontName="Montserrat", fontSize=8, textColor=GFG_GRAY, leading=11,
    )

    story = [
        _NavyHeaderBand(page_width),
        Spacer(1, 0.35 * inch),
    ]

    # "Prepared for" / pay period block, indented to match the body margin
    # used everywhere below (the header band itself runs edge-to-edge).
    meta_table = Table(
        [
            [Paragraph("PREPARED FOR", label_style), Paragraph("PAY PERIOD", label_style)],
            [Paragraph(driver_name, value_style), Paragraph(_fmt_pay_date(pay_period_id), value_style)],
        ],
        colWidths=[3.6 * inch, 3.6 * inch],
    )
    meta_table.setStyle(TableStyle([
        ("LEFTPADDING", (0, 0), (-1, -1), 0.4 * inch),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ("TOPPADDING", (0, 0), (-1, -1), 2),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 2),
    ]))
    story.append(meta_table)
    story.append(Spacer(1, 0.4 * inch))

    # The recap table itself, styled like a simple statement -- three line
    # items then a visually distinct Total row.
    rows = [
        ["Tips", _currency(tips)],
        ["Deliveries", _currency(deliveries)],
        ["Setups", _currency(setups)],
        ["Total", _currency(total)],
    ]
    recap = Table(rows, colWidths=[5.7 * inch, 1.5 * inch])
    recap.setStyle(TableStyle([
        ("FONTNAME", (0, 0), (-1, 2), "Montserrat"),
        ("FONTSIZE", (0, 0), (-1, 2), 11),
        ("FONTNAME", (0, 3), (-1, 3), "Montserrat-Bold"),
        ("FONTSIZE", (0, 3), (-1, 3), 13),
        ("TEXTCOLOR", (0, 3), (-1, 3), GFG_NAVY),
        ("ALIGN", (1, 0), (1, -1), "RIGHT"),
        ("LINEBELOW", (0, 0), (-1, 2), 0.5, colors.HexColor("#DADFE6")),
        ("LINEABOVE", (0, 3), (-1, 3), 1.2, GFG_NAVY),
        ("BACKGROUND", (0, 3), (-1, 3), GFG_NAVY_LIGHT),
        ("TOPPADDING", (0, 0), (-1, -1), 8),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
        ("LEFTPADDING", (0, 0), (-1, -1), 14),
        ("RIGHTPADDING", (0, 0), (-1, -1), 14),
        ("BOX", (0, 0), (-1, -1), 0.75, colors.HexColor("#DADFE6")),
    ]))
    # Indent the recap table to match the meta block above.
    wrapper = Table([[recap]], colWidths=[7.2 * inch])
    wrapper.setStyle(TableStyle([
        ("LEFTPADDING", (0, 0), (-1, -1), 0.4 * inch),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0.4 * inch),
    ]))
    story.append(wrapper)
    story.append(Spacer(1, 0.5 * inch))

    footer_lines = [
        "This advice reflects 1099 independent-contractor courier compensation, not W-2 wages.",
        f"Questions about this payment? Contact {review_email}.",
        f"Generated by GFG Payroll on {datetime.now().strftime('%B %-d, %Y')}.",
    ]
    footer_table = Table(
        [[Paragraph("<br/>".join(footer_lines), footer_style)]],
        colWidths=[7.2 * inch],
    )
    footer_table.setStyle(TableStyle([
        ("LEFTPADDING", (0, 0), (-1, -1), 0.4 * inch),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0.4 * inch),
    ]))
    story.append(footer_table)

    doc.build(story)
    buf.seek(0)
    return buf.read()


def safe_filename(driver_name, pay_period_id):
    """Filesystem/Storage-object-safe filename for one driver's PDF."""
    slug = "".join(c if c.isalnum() else "_" for c in driver_name).strip("_")
    return f"{pay_period_id}_{slug}_Driver_Payment_Advice.pdf"
