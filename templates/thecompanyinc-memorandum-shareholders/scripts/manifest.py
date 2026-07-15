"""Single source of truth for the Memorandum of Action by Shareholders (organizational
shareholder consent). Read by the shared create-doc wizard (flakes/legal/wizard).

A flat consent — no node tree (NODES is empty), so the wizard just fills the value-bearing
fields below and writes src/variables.tex. `firm=True` fields (company, state, the six
shareholders and their share counts) seed settings.json; the deal field (the "dated as of"
date) starts blank and renders as a fill-in rule until filled.

Share counts are kind="text" so "2,750" prints literally (no spelling-out). The share-issuance
tabular and the two-column director grid are laid out in src/content.tex; only the names and
counts are variables here.
"""

TITLE = "Memorandum of Action by Shareholders"

G_FIRM = "Corporation"
G_HOLDERS = "Shareholders (names + share counts)"
G_DATE = "Date"

INPUTS = [
    dict(name="companyName", group=G_FIRM, kind="text", firm=True,
         default="The Company, Inc.", prompt="Corporation name"),
    dict(name="companyState", group=G_FIRM, kind="text", firm=True,
         default="Colorado", prompt="State of incorporation"),

    dict(name="shareholderOne", group=G_HOLDERS, kind="text", firm=True,
         default="Cole Calamos", prompt="Shareholder 1"),
    dict(name="sharesOne", group=G_HOLDERS, kind="text", firm=True,
         default="2,750", prompt="Shares for Shareholder 1"),
    dict(name="shareholderTwo", group=G_HOLDERS, kind="text", firm=True,
         default="Madeline Calamos", prompt="Shareholder 2"),
    dict(name="sharesTwo", group=G_HOLDERS, kind="text", firm=True,
         default="2,750", prompt="Shares for Shareholder 2"),
    dict(name="shareholderThree", group=G_HOLDERS, kind="text", firm=True,
         default="Matthew Storer", prompt="Shareholder 3"),
    dict(name="sharesThree", group=G_HOLDERS, kind="text", firm=True,
         default="1,750", prompt="Shares for Shareholder 3"),
    dict(name="shareholderFour", group=G_HOLDERS, kind="text", firm=True,
         default="David Benson", prompt="Shareholder 4"),
    dict(name="sharesFour", group=G_HOLDERS, kind="text", firm=True,
         default="1,750", prompt="Shares for Shareholder 4"),
    dict(name="shareholderFive", group=G_HOLDERS, kind="text", firm=True,
         default="Micah Meleski", prompt="Shareholder 5"),
    dict(name="sharesFive", group=G_HOLDERS, kind="text", firm=True,
         default="500", prompt="Shares for Shareholder 5"),
    dict(name="shareholderSix", group=G_HOLDERS, kind="text", firm=True,
         default="Lauren Meleski", prompt="Shareholder 6"),
    dict(name="sharesSix", group=G_HOLDERS, kind="text", firm=True,
         default="500", prompt="Shares for Shareholder 6"),

    dict(name="datedText", group=G_DATE, kind="date", blank=True, default="",
         prompt="Dated as of (MM/DD/YYYY)"),
]

# Flat document: no toggleable node tree, no defined terms.
NODES = []
DEFINED_TERMS = {}

SUMMARY_FIELDS = [
    ("Corporation", "companyName"),
    ("State", "companyState"),
    ("Shareholder 1", "shareholderOne"),
    ("Shareholder 6", "shareholderSix"),
    ("Dated as of", "datedText"),
]
