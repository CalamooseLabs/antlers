"""Single source of truth for the Authentication of Record Book and Records of The
Company, Inc. Read by the shared create-doc wizard (flakes/legal/wizard).

A flat authentication — no node tree (NODES is empty), so the wizard just fills the
value-bearing fields below and writes src/variables.tex. `firm=True` fields (company,
state, the six directors) seed settings.json; the instance fields (the day/month of the
two dated blanks and the city/county of execution) start blank and render as fill-in
rules until filled. The year 2026 is written literally in the prose, per the source.
"""

TITLE = "Authentication of Record Book and Records"

G_FIRM = "Corporation"
G_EXEC = "Execution (blanks in the paragraph)"
G_DIRECTORS = "Directors (signature block)"

INPUTS = [
    dict(name="companyName", group=G_FIRM, kind="text", firm=True,
         default="The Company, Inc.", prompt="Corporation name"),
    dict(name="companyState", group=G_FIRM, kind="text", firm=True,
         default="Colorado", prompt="State of incorporation"),

    dict(name="dayOne", group=G_EXEC, kind="text", blank=True, default="",
         prompt="Certificate issuance — day of the month (1st blank)"),
    dict(name="monthOne", group=G_EXEC, kind="text", blank=True, default="",
         prompt="Certificate issuance — month (1st blank)"),
    dict(name="city", group=G_EXEC, kind="text", blank=True, default="",
         prompt="City of execution"),
    dict(name="county", group=G_EXEC, kind="text", blank=True, default="",
         prompt="County of execution"),
    dict(name="dayTwo", group=G_EXEC, kind="text", blank=True, default="",
         prompt="Subscription — day of the month (2nd blank)"),
    dict(name="monthTwo", group=G_EXEC, kind="text", blank=True, default="",
         prompt="Subscription — month (2nd blank)"),

    dict(name="directorOne", group=G_DIRECTORS, kind="text", firm=True,
         default="Cole Calamos", prompt="Director 1 (row 1, left)"),
    dict(name="directorTwo", group=G_DIRECTORS, kind="text", firm=True,
         default="Micah Meleski", prompt="Director 2 (row 1, right)"),
    dict(name="directorThree", group=G_DIRECTORS, kind="text", firm=True,
         default="Madeline Calamos", prompt="Director 3 (row 2, left)"),
    dict(name="directorFour", group=G_DIRECTORS, kind="text", firm=True,
         default="Lauren Meleski", prompt="Director 4 (row 2, right)"),
    dict(name="directorFive", group=G_DIRECTORS, kind="text", firm=True,
         default="David Benson", prompt="Director 5 (row 3, left)"),
    dict(name="directorSix", group=G_DIRECTORS, kind="text", firm=True,
         default="Matthew Storer", prompt="Director 6 (row 3, right)"),
]

# Flat document: no toggleable node tree, no defined terms.
NODES = []
DEFINED_TERMS = {}

SUMMARY_FIELDS = [
    ("Corporation", "companyName"),
    ("State", "companyState"),
    ("Certificate day", "dayOne"),
    ("Certificate month", "monthOne"),
    ("City", "city"),
    ("County", "county"),
    ("Subscription day", "dayTwo"),
    ("Subscription month", "monthTwo"),
]
