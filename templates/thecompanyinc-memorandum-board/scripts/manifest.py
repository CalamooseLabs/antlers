"""Single source of truth for the organizational board consent (Memorandum of Action of
Directors). Read by the shared create-doc wizard (flakes/legal/wizard).

A flat consent — no node tree (NODES is empty), so the wizard just fills the value-bearing
fields below and writes src/variables.tex. `firm=True` fields (company, state, president, the
six directors) seed settings.json; the deal fields (secretary/treasurer elected, date) start
blank and render as fill-in rules until filled.
"""

TITLE = "Board Memorandum — Memorandum of Action of Directors"

G_FIRM = "Corporation"
G_OFFICERS = "Officers elected"
G_DIRECTORS = "Directors (signature block)"
G_DATE = "Date"

INPUTS = [
    dict(name="companyName", group=G_FIRM, kind="text", firm=True,
         default="The Company, Inc.", prompt="Corporation name"),
    dict(name="companyState", group=G_FIRM, kind="text", firm=True,
         default="Colorado", prompt="State of incorporation"),

    dict(name="president", group=G_OFFICERS, kind="text", firm=True,
         default="Cole Calamos", prompt="President"),
    dict(name="secretary", group=G_OFFICERS, kind="text", blank=True, default="",
         prompt="Secretary"),
    dict(name="treasurer", group=G_OFFICERS, kind="text", blank=True, default="",
         prompt="Treasurer"),

    dict(name="directorOne", group=G_DIRECTORS, kind="text", firm=True,
         default="Cole Calamos", prompt="Director 1 (left, row 1)"),
    dict(name="directorTwo", group=G_DIRECTORS, kind="text", firm=True,
         default="Micah Meleski", prompt="Director 2 (right, row 1)"),
    dict(name="directorThree", group=G_DIRECTORS, kind="text", firm=True,
         default="Madeline Calamos", prompt="Director 3 (left, row 2)"),
    dict(name="directorFour", group=G_DIRECTORS, kind="text", firm=True,
         default="Lauren Meleski", prompt="Director 4 (right, row 2)"),
    dict(name="directorFive", group=G_DIRECTORS, kind="text", firm=True,
         default="David Benson", prompt="Director 5 (left, row 3)"),
    dict(name="directorSix", group=G_DIRECTORS, kind="text", firm=True,
         default="Matthew Storer", prompt="Director 6 (right, row 3)"),

    dict(name="datedText", group=G_DATE, kind="date", blank=True, default="",
         prompt="Dated (MM/DD/YYYY)"),
]

# Flat document: no toggleable node tree, no defined terms.
NODES = []
DEFINED_TERMS = {}

SUMMARY_FIELDS = [
    ("President", "president"),
    ("Secretary", "secretary"),
    ("Treasurer", "treasurer"),
    ("Dated", "datedText"),
]
