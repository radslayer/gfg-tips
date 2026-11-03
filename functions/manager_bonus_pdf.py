"""Generates one branded PDF per Kitchen Manager/Supervisor bonus recipient
("Bonus Advice"), built from the same numbers already shown on the Payroll
Report's "Bonus Calc" worksheet (per-week Sales/Kitchen-Hour ratios,
average, bracket multiplier, resulting $ amount).

Added 11/3/2026 (per Guapo: "I also need a bonus recap for managers
similar to what you produce for the drivers"). Only built for a period
where a bonus actually triggers AND someone is tagged for that role (see
main.py's generate_payroll_report) -- there is nothing to recap on a
period where neither bonus applies.

Same separation-of-concerns pattern as driver_advice_pdf.py (this module
is ONLY the PDF-rendering piece; it takes plain numbers in and PDF bytes
out) and the same branding (GFG navy #2B3C5E, Montserrat, the reversed
logo mark) -- deliberately a near-duplicate of that module's layout
rather than a shared helper, matching how report_builder.py and
driver_advice_pdf.py already stay separate, self-contained modules.
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
    """Same navy header band as driver_advice_pdf.py, but with the role
    name as the subtitle instead of a fixed "Driver Payment Advice"."""

    def __init__(self, width, subtitle, height=1.15 * inch):
        Flowable.__init__(self)
        self.width = width
        self.subtitle = subtitle
        self.height = height

    def draw(self):
        c = self.canv
        c.setFillColor(GFG_NAVY)
        c.rect(0, 0, self.width, self.height, stroke=0, fill=1)

        logo = _get_logo_reader()
        logo_w, logo_h = logo.getSize()
        icon_h = 0.8 * inch
        icon_w = icon_h * (logo_w / logo_h)
        icon_x = 0.4 * inch
        icon_y = (self.height - icon_h) / 2
        c.drawImage(logo, icon_x, icon_y, width=icon_w, height=icon_h, mask="auto")

        text_x = icon_x + icon_w + 0.25 * inch
        c.setFillColor(colors.white)
        c.setFont("Montserrat-Bold", 20)
        c.drawString(text_x, self.height - 0.48 * inch, "Gourmet for Good®")
        c.setFont("Montserrat", 11)
        c.drawString(text_x, self.height - 0.78 * inch, self.subtitle)


def _currency(value):
    value = float(value or 0)
    sign = "-" if value < 0 else ""
    return f"{sign}${abs(value):,.2f}"


def _fmt_pay_date(pay_period_id):
    try:
        return datetime.strptime(pay_period_id, "%Y-%m-%d").strftime("%B %-d, %Y")
    except ValueError:
        return pay_period_id


def _fmt_week_ending(date_str):
    """weekEnding on each weeklyDetail entry is a plain YYYY-MM-DD string
    (see report_builder.py's bonuses_paid) -- render it the short way."""
    try:
        return datetime.strptime(date_str, "%Y-%m-%d").strftime("%-m/%-d/%Y")
    except (ValueError, TypeError):
        return date_str or ""


def build_manager_bonus_pdf(employee_name, role, pay_period_id, weekly_detail,
                             avg_ratio, window_weeks, multiplier, bonus_basis,
                             amount, quarter=None,
                             review_email="getinfo@gourmetforgood.com"):
    """Returns PDF bytes for one Kitchen Manager/Supervisor bonus recap.

    weekly_detail: list of {"weekEnding": "YYYY-MM-DD", "ratio": float},
    one entry per week inside the averaging window used for this bonus
    (this period's week(s) plus however much trailing/quarter history was
    available) -- exactly report_builder.py's bonuses_paid[i]["weeklyDetail"].
    avg_ratio/window_weeks/multiplier/amount are that same bonuses_paid
    entry's avgRatio/windowWeeks/multiplier/amount. quarter (Supervisor
    only) is the pre-formatted "MM/DD/YYYY-MM/DD/YYYY" string already on
    that entry, or None for the Kitchen Manager's trailing-4-week window.
    bonus_basis is the flat $ basis (BONUS_BASIS in report_builder.py)
    the multiplier is applied to.
    """
    _register_fonts()

    weekly_detail = weekly_detail or []
    avg_ratio = round(float(avg_ratio or 0), 2)
    amount = round(float(amount or 0), 2)
    bonus_basis = round(float(bonus_basis or 0), 2)

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
        _NavyHeaderBand(page_width, f"{role} Bonus Advice"),
        Spacer(1, 0.35 * inch),
    ]

    meta_table = Table(
        [
            [Paragraph("PREPARED FOR", label_style), Paragraph("PAY PERIOD", label_style)],
            [Paragraph(employee_name or "(unassigned)", value_style),
             Paragraph(_fmt_pay_date(pay_period_id), value_style)],
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

    # Full breakdown: every week in the averaging window (per Guapo --
    # "full breakdown" over a bottom-line-only recap), then the average/
    # multiplier/basis math, then the bonus amount as a visually distinct
    # Total row -- same statement-style layout as the driver recap.
    window_desc = f"{window_weeks} week(s)"
    if quarter:
        window_desc += f" ({quarter})"

    rows = [["Week Ending", "Sales / Kitchen Hour"]]
    for wk in weekly_detail:
        rows.append([_fmt_week_ending(wk.get("weekEnding")), f'{wk.get("ratio", 0):,.2f}'])
    detail_table = Table(rows, colWidths=[5.7 * inch, 1.5 * inch])
    detail_table.setStyle(TableStyle([
        ("FONTNAME", (0, 0), (-1, 0), "Montserrat-Bold"),
        ("FONTNAME", (0, 1), (-1, -1), "Montserrat"),
        ("FONTSIZE", (0, 0), (-1, -1), 10.5),
        ("TEXTCOLOR", (0, 0), (-1, 0), GFG_NAVY),
        ("BACKGROUND", (0, 0), (-1, 0), GFG_NAVY_LIGHT),
        ("ALIGN", (1, 0), (1, -1), "RIGHT"),
        ("LINEBELOW", (0, 0), (-1, -1), 0.5, colors.HexColor("#DADFE6")),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
        ("LEFTPADDING", (0, 0), (-1, -1), 14),
        ("RIGHTPADDING", (0, 0), (-1, -1), 14),
        ("BOX", (0, 0), (-1, -1), 0.75, colors.HexColor("#DADFE6")),
    ]))
    wrapper1 = Table([[detail_table]], colWidths=[7.2 * inch])
    wrapper1.setStyle(TableStyle([
        ("LEFTPADDING", (0, 0), (-1, -1), 0.4 * inch),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0.4 * inch),
    ]))
    story.append(wrapper1)
    story.append(Spacer(1, 0.3 * inch))

    calc_rows = [
        [f"Average Sales/Kitchen-Hour over {window_desc}", f"{avg_ratio:,.2f}"],
        ["Bracket multiplier", f"{multiplier}x"],
        ["Bonus basis", _currency(bonus_basis)],
        [f"Bonus this period ({role})", _currency(amount)],
    ]
    last_row = len(calc_rows) - 1
    calc_table = Table(calc_rows, colWidths=[5.7 * inch, 1.5 * inch])
    calc_table.setStyle(TableStyle([
        ("FONTNAME", (0, 0), (-1, last_row - 1), "Montserrat"),
        ("FONTSIZE", (0, 0), (-1, last_row - 1), 11),
        ("FONTNAME", (0, last_row), (-1, last_row), "Montserrat-Bold"),
        ("FONTSIZE", (0, last_row), (-1, last_row), 13),
        ("TEXTCOLOR", (0, last_row), (-1, last_row), GFG_NAVY),
        ("ALIGN", (1, 0), (1, -1), "RIGHT"),
        ("LINEBELOW", (0, 0), (-1, last_row - 1), 0.5, colors.HexColor("#DADFE6")),
        ("LINEABOVE", (0, last_row), (-1, last_row), 1.2, GFG_NAVY),
        ("BACKGROUND", (0, last_row), (-1, last_row), GFG_NAVY_LIGHT),
        ("TOPPADDING", (0, 0), (-1, -1), 8),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
        ("LEFTPADDING", (0, 0), (-1, -1), 14),
        ("RIGHTPADDING", (0, 0), (-1, -1), 14),
        ("BOX", (0, 0), (-1, -1), 0.75, colors.HexColor("#DADFE6")),
    ]))
    wrapper2 = Table([[calc_table]], colWidths=[7.2 * inch])
    wrapper2.setStyle(TableStyle([
        ("LEFTPADDING", (0, 0), (-1, -1), 0.4 * inch),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0.4 * inch),
    ]))
    story.append(wrapper2)
    story.append(Spacer(1, 0.5 * inch))

    footer_lines = [
        f"{role} bonus based on Sales-per-Kitchen-Hour performance against GFG's bonus "
        "bracket schedule.",
        f"Questions about this bonus? Contact {review_email}.",
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


def safe_filename(employee_name, role, pay_period_id):
    """Filesystem/Storage-object-safe filename for one manager's PDF."""
    slug = "".join(c if c.isalnum() else "_" for c in (employee_name or "unassigned")).strip("_")
    role_slug = "".join(c if c.isalnum() else "_" for c in role).strip("_")
    return f"{pay_period_id}_{slug}_{role_slug}_Bonus_Advice.pdf"
