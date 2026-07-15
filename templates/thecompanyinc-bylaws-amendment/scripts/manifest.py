"""Single source of truth for the Amendment to Bylaws — a reusable instrument that amends
one or more sections of the Corporation's Bylaws. Read by the shared create-doc wizard
(flakes/legal/wizard).

A flat instrument — no node tree (NODES is empty), so the wizard just fills the
value-bearing fields below and writes src/variables.tex. `firm=True` fields (company, state,
the six directors) seed settings.json; the deal fields (effective date, the section being
amended, its new text, the certifying Secretary) start blank and render as fill-in rules
until filled, so a blank template prints ready-to-complete rules.
"""

TITLE = "Amendment to Bylaws"

G_FIRM = "Corporation"
G_TERMS = "Amendment terms"
G_CERT = "Certification"
G_DIRECTORS = "Directors / Shareholders (signature block)"

INPUTS = [
    dict(name="companyName", group=G_FIRM, kind="text", firm=True,
         default="The Company, Inc.", prompt="Corporation name"),
    dict(name="companyState", group=G_FIRM, kind="text", firm=True,
         default="Colorado", prompt="State of incorporation"),

    dict(name="effectiveDate", group=G_TERMS, kind="date", blank=True, default="",
         prompt="Effective date (MM/DD/YYYY)"),
    dict(name="statuteCite", group=G_TERMS, kind="text", blank=True, default="",
         prompt="C.R.S. cite (blank leaves a fill-in rule)"),
    dict(name="amendedSection", group=G_TERMS, kind="text", blank=True, default="",
         prompt="Section of the Bylaws being amended (e.g. Section 3.2)"),
    dict(name="amendedText", group=G_TERMS, kind="text", blank=True, default="",
         prompt="New text of the amended section (leave blank for a fill-in)"),

    dict(name="secretaryName", group=G_CERT, kind="text", blank=True, default="",
         prompt="Secretary certifying adoption"),

    dict(name="directorOne", group=G_DIRECTORS, kind="text", firm=True,
         default="Cole Calamos", prompt="Director / Shareholder 1 (left, row 1)"),
    dict(name="directorTwo", group=G_DIRECTORS, kind="text", firm=True,
         default="Micah Meleski", prompt="Director / Shareholder 2 (right, row 1)"),
    dict(name="directorThree", group=G_DIRECTORS, kind="text", firm=True,
         default="Madeline Calamos", prompt="Director / Shareholder 3 (left, row 2)"),
    dict(name="directorFour", group=G_DIRECTORS, kind="text", firm=True,
         default="Lauren Meleski", prompt="Director / Shareholder 4 (right, row 2)"),
    dict(name="directorFive", group=G_DIRECTORS, kind="text", firm=True,
         default="David Benson", prompt="Director / Shareholder 5 (left, row 3)"),
    dict(name="directorSix", group=G_DIRECTORS, kind="text", firm=True,
         default="Matthew Storer", prompt="Director / Shareholder 6 (right, row 3)"),
]

# Flat instrument: no toggleable node tree, no defined terms.
NODES = []
DEFINED_TERMS = {}

SUMMARY_FIELDS = [
    ("Corporation", "companyName"),
    ("Effective date", "effectiveDate"),
    ("Section amended", "amendedSection"),
    ("Secretary", "secretaryName"),
]
