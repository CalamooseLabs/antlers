"""Single source of truth for the buy-sell Promissory Note (Form of Note — Schedule A of the
Shareholders Agreement, delivered when a Buying Party elects to pay the purchase price in
installments). Read by the shared create-doc wizard (flakes/legal/wizard).

A flat instrument — no node tree (NODES is empty), so the wizard just fills the value-bearing
fields below and writes src/variables.tex. `firm=True` fields (company name + state of
organization) seed settings.json; the deal fields (principal, dates, the specific Payor and
Holder, the installment amounts, the venue county) start blank and render as fill-in rules
until filled in.
"""

TITLE = "Promissory Note — Buy-Sell Installment Note (Shareholders Agreement Schedule A)"

G_FIRM = "Corporation"
G_HEADER = "Note terms (header block)"
G_PARTIES = "Parties"
G_PAYMENTS = "Installments"
G_VENUE = "Venue"

INPUTS = [
    dict(name="companyName", group=G_FIRM, kind="text", firm=True,
         default="The Company, Inc.", prompt="Corporation name"),
    dict(name="companyState", group=G_FIRM, kind="text", firm=True,
         default="Colorado", prompt="State of organization / governing law"),

    dict(name="principalAmount", group=G_HEADER, kind="money_simple", blank=True, default="",
         prompt="Principal amount of note (e.g. 250000)"),
    dict(name="effectiveDate", group=G_HEADER, kind="date", blank=True, default="",
         prompt="Effective Date (MM/DD/YYYY)"),
    dict(name="maturityDate", group=G_HEADER, kind="date", blank=True, default="",
         prompt="Maturity Date (MM/DD/YYYY)"),

    dict(name="payorName", group=G_PARTIES, kind="text", blank=True, default="",
         prompt="Payor (name of Buying Party — the Corporation or a Shareholder)"),
    dict(name="holderName", group=G_PARTIES, kind="text", blank=True, default="",
         prompt="Holder (name of Transferring Shareholder)"),

    dict(name="installmentAmount", group=G_PAYMENTS, kind="money_simple", blank=True, default="",
         prompt="Amount of each of the 83 equal monthly installments (e.g. 3200)"),
    dict(name="finalInstallment", group=G_PAYMENTS, kind="money_simple", blank=True, default="",
         prompt="Amount of the final (84th) installment due on the Maturity Date"),

    dict(name="venueCounty", group=G_VENUE, kind="text", blank=True, default="",
         prompt="County of venue / jurisdiction"),
]

# Flat instrument: no toggleable node tree. Defined terms in the note (Payor, Holder,
# Maturity Date, Interest Rate, Event of Default) are introduced inline with plain
# double-quotes, so no cross-linked DEFINED_TERMS map is used.
NODES = []
DEFINED_TERMS = {}

SUMMARY_FIELDS = [
    ("Principal amount", "principalAmount"),
    ("Effective Date", "effectiveDate"),
    ("Maturity Date", "maturityDate"),
    ("Payor", "payorName"),
    ("Holder", "holderName"),
    ("Each of 83 installments", "installmentAmount"),
    ("Final installment", "finalInstallment"),
    ("Venue county", "venueCounty"),
]
