"""Single source of truth for the Amendment to Shareholders Agreement. Read by the shared
create-doc wizard (flakes/legal/wizard).

A reusable amendment shell for The Company, Inc.'s Shareholders Agreement — a flat document
(NODES is empty), so the wizard just fills the value-bearing fields below and writes
src/variables.tex. `firm=True` fields (company, state, president, the six shareholders) seed
settings.json; the deal fields (effective date, original agreement date, the section being
amended and its restated text) start blank and render as fill-in rules until filled.
"""

TITLE = "Amendment to Shareholders Agreement — The Company, Inc."

G_FIRM = "Corporation"
G_DEAL = "This amendment"
G_SIGNERS = "Signature block (President + Shareholders)"

INPUTS = [
    dict(name="companyName", group=G_FIRM, kind="text", firm=True,
         default="The Company, Inc.", prompt="Corporation name"),
    dict(name="companyState", group=G_FIRM, kind="text", firm=True,
         default="Colorado", prompt="State of incorporation"),
    dict(name="president", group=G_FIRM, kind="text", firm=True,
         default="Cole Calamos", prompt="President (signs for the Corporation)"),

    dict(name="effectiveDate", group=G_DEAL, kind="date", blank=True, default="",
         prompt="Effective date of this Amendment (MM/DD/YYYY)"),
    dict(name="originalAgreementDate", group=G_DEAL, kind="date", blank=True, default="",
         prompt="Date of the original Shareholders Agreement (MM/DD/YYYY)"),
    dict(name="amendedSection", group=G_DEAL, kind="text", blank=True, default="",
         prompt="Section of the Agreement being amended (e.g. 3.2)"),
    dict(name="amendedText", group=G_DEAL, kind="text", blank=True, default="",
         blank_width="12cm", prompt="New (amended and restated) text for that Section"),

    dict(name="directorOne", group=G_SIGNERS, kind="text", firm=True,
         default="Cole Calamos", prompt="Shareholder 1"),
    dict(name="directorTwo", group=G_SIGNERS, kind="text", firm=True,
         default="Micah Meleski", prompt="Shareholder 2"),
    dict(name="directorThree", group=G_SIGNERS, kind="text", firm=True,
         default="Madeline Calamos", prompt="Shareholder 3"),
    dict(name="directorFour", group=G_SIGNERS, kind="text", firm=True,
         default="Lauren Meleski", prompt="Shareholder 4"),
    dict(name="directorFive", group=G_SIGNERS, kind="text", firm=True,
         default="David Benson", prompt="Shareholder 5"),
    dict(name="directorSix", group=G_SIGNERS, kind="text", firm=True,
         default="Matthew Storer", prompt="Shareholder 6"),
]

# Flat document: no toggleable node tree, no defined terms.
NODES = []
DEFINED_TERMS = {}

SUMMARY_FIELDS = [
    ("Effective date", "effectiveDate"),
    ("Original Agreement dated", "originalAgreementDate"),
    ("Section amended", "amendedSection"),
    ("President", "president"),
]
