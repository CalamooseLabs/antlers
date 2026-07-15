"""Single source of truth for the Intellectual Property License Agreement. Read by the shared
create-doc wizard (flakes/legal/wizard).

A flat transactional agreement — no node tree (NODES is empty), so the wizard just fills the
value-bearing fields below and writes src/variables.tex. `firm=True` fields (Licensor company
name/state, Licensor notice email) seed settings.json; the deal fields (Licensee, fees,
dates, notice periods, venue county, signature block) start blank and render as fill-in rules
until filled. Key defined terms are wired through DEFINED_TERMS so the prose links each use
back to its definition in Section 2.
"""

TITLE = "Intellectual Property License Agreement"

G_FIRM = "Licensor (firm standing facts)"
G_LICENSEE = "Licensee"
G_FEES = "Fees; Payment"
G_TERM = "Term; Termination"
G_VENUE = "Governing Law; Venue"
G_NOTICE = "Notices"
G_SIG = "Signature blocks"

INPUTS = [
    # ---- Licensor: firm standing facts (seed settings.json) ----
    dict(name="companyName", group=G_FIRM, kind="text", firm=True,
         default="The Company, Inc.", prompt="Licensor corporation name"),
    dict(name="companyState", group=G_FIRM, kind="text", firm=True,
         default="Colorado", prompt="State of incorporation"),
    dict(name="licensorEmail", group=G_FIRM, kind="text", firm=True,
         default="contact@thecompany.inc", prompt="Licensor notice email"),

    # ---- Effective Date (intro) ----
    dict(name="effectiveDate", group=G_LICENSEE, kind="date", default="",
         prompt="Effective Date (intro, MM/DD/YYYY)"),

    # ---- Licensee: deal instance (blank until filled) ----
    dict(name="licenseeName", group=G_LICENSEE, kind="text", blank=True, default="",
         prompt="Licensee name"),
    dict(name="licenseeType", group=G_LICENSEE, kind="text", blank=True, default="",
         prompt="Licensee entity type / description (e.g. a Colorado limited liability company)"),

    # ---- Fees; Payment (deal instance) ----
    dict(name="licenseFee", group=G_FEES, kind="text", blank=True, default="",
         prompt="License Fee (7.1) — e.g. $5,000.00, or a description"),
    dict(name="paymentTerms", group=G_FEES, kind="text", blank=True, default="",
         prompt="Payment terms / schedule (7.2)"),
    dict(name="paymentTo", group=G_FEES, kind="text", blank=True, default="",
         prompt="Payment must be made to (7.2)"),
    dict(name="lateInterest", group=G_FEES, kind="text", blank=True, default="",
         prompt="Late-payment interest per month (7.3) — e.g. 1.5\\%"),

    # ---- Term; Termination (deal instance) ----
    dict(name="expirationDate", group=G_TERM, kind="date", default="",
         prompt="Expiration Date (9.1, MM/DD/YYYY)"),
    dict(name="terminationNoticeDays", group=G_TERM, kind="count", blank=True, default="",
         suffix=" days", prompt="Termination-for-convenience notice period (9.2), in days"),
    dict(name="cureDays", group=G_TERM, kind="count", blank=True, default="",
         suffix=" days", prompt="Cure period for material breach (9.3), in days"),

    # ---- Governing Law; Venue (deal instance) ----
    dict(name="venueCounty", group=G_VENUE, kind="text", blank=True, default="",
         prompt="Venue county (15.6)"),

    # ---- Notices (deal instance) ----
    dict(name="licensorAttn", group=G_NOTICE, kind="text", blank=True, default="",
         prompt="Licensor notice Attn (14)"),
    dict(name="licenseeEmail", group=G_NOTICE, kind="text", blank=True, default="",
         prompt="Licensee notice email (14)"),
    dict(name="licenseeAttn", group=G_NOTICE, kind="text", blank=True, default="",
         prompt="Licensee notice Attn (14)"),

    # ---- Signature blocks (deal instance) ----
    dict(name="licensorSignName", group=G_SIG, kind="text", blank=True, default="",
         prompt="Licensor signatory name"),
    dict(name="licensorSignTitle", group=G_SIG, kind="text", blank=True, default="",
         prompt="Licensor signatory title"),
    dict(name="licenseeSignName", group=G_SIG, kind="text", blank=True, default="",
         prompt="Licensee signatory name"),
    dict(name="licenseeSignTitle", group=G_SIG, kind="text", blank=True, default="",
         prompt="Licensee signatory title"),
]

# Flat document: no toggleable node tree.
NODES = []

# Key defined terms (Section 2) — \<key> renders in small caps and links back to the
# \dtdef anchor at the definition.
DEFINED_TERMS = {
    "licensedIP": "Licensed IP",
    "masters": "Masters",
    "compositions": "Compositions",
    "project": "Project",
    "permittedUses": "Permitted Uses",
    "territory": "Territory",
    "termDef": "Term",
    "derivativeWorks": "Derivative Works",
}

SUMMARY_FIELDS = [
    ("Licensee", "licenseeName"),
    ("License Fee", "licenseFee"),
    ("Expiration Date", "expirationDate"),
    ("Convenience notice", "terminationNoticeDays"),
    ("Cure period", "cureDays"),
    ("Venue county", "venueCounty"),
]
