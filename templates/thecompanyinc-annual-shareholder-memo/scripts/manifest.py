"""Single source of truth for the Annual Shareholder Memo (Memorandum of Annual Action of
Shareholders). Read by the shared create-doc wizard (flakes/legal/wizard).

A flat consent — no node tree (NODES is empty), so the wizard just fills the value-bearing
fields below and writes src/variables.tex. `firm=True` fields (company, state, the six
directors elected by the shareholders) seed settings.json; the deal field (the date) starts
blank and renders as a fill-in rule until filled.

The six directors are the six shareholders. `directorOne`…`directorSix` are ordered so the
signature grid pairs them left|right per row: Cole | Micah ; Madeline | Lauren ;
David | Matthew.
"""

TITLE = "Annual Shareholder Memo — Memorandum of Annual Action of Shareholders"

G_FIRM = "Corporation"
G_DIRECTORS = "Directors elected / signature block"
G_DATE = "Date"

INPUTS = [
    dict(name="companyName", group=G_FIRM, kind="text", firm=True,
         default="The Company, Inc.", prompt="Corporation name"),
    dict(name="companyState", group=G_FIRM, kind="text", firm=True,
         default="Colorado", prompt="State of incorporation"),

    dict(name="directorOne", group=G_DIRECTORS, kind="text", firm=True,
         default="Cole Calamos", prompt="Director 1"),
    dict(name="directorTwo", group=G_DIRECTORS, kind="text", firm=True,
         default="Micah Meleski", prompt="Director 2"),
    dict(name="directorThree", group=G_DIRECTORS, kind="text", firm=True,
         default="Madeline Calamos", prompt="Director 3"),
    dict(name="directorFour", group=G_DIRECTORS, kind="text", firm=True,
         default="Lauren Meleski", prompt="Director 4"),
    dict(name="directorFive", group=G_DIRECTORS, kind="text", firm=True,
         default="David Benson", prompt="Director 5"),
    dict(name="directorSix", group=G_DIRECTORS, kind="text", firm=True,
         default="Matthew Storer", prompt="Director 6"),

    dict(name="datedText", group=G_DATE, kind="date", default="",
         prompt="Dated (MM/DD/YYYY)"),
]

# Flat document: no toggleable node tree, no defined terms.
NODES = []
DEFINED_TERMS = {}

SUMMARY_FIELDS = [
    ("Corporation", "companyName"),
    ("State", "companyState"),
    ("Director 1", "directorOne"),
    ("Dated", "datedText"),
]
