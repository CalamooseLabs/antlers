"""Single source of truth for the Bill of Sale and Assignment of Assets. Read by the shared
create-doc wizard (flakes/legal/wizard).

A flat transactional agreement — no node tree (NODES is empty), so the wizard just fills the
value-bearing fields below and writes src/variables.tex. `firm=True` fields (the Company's
name, state, and address) seed settings.json; the deal fields (the specific Seller, price,
dates, venue, and signatures) start blank and render as fill-in rules until filled.

The Company, Inc. is always the buyer ("the Company"); the Seller and the commercial terms
are per-instance blanks.
"""

TITLE = "Bill of Sale — Bill of Sale and Assignment of Assets"

G_COMPANY = "The Company (buyer)"
G_SELLER = "Seller"
G_DEAL = "Deal terms"
G_ASSETS = "Assets"
G_LEGAL = "Governing law / taxes"
G_SIG = "Signatures"

INPUTS = [
    # ---- Firm-standing facts (buyer) -> settings.json ----
    dict(name="companyName", group=G_COMPANY, kind="text", firm=True,
         default="The Company, Inc.", prompt="Company (buyer) name"),
    dict(name="companyState", group=G_COMPANY, kind="text", firm=True,
         default="Colorado", prompt="Company state of incorporation"),
    dict(name="companyAddress", group=G_COMPANY, kind="text", firm=True, blank=True,
         default="", blank_width="3cm", prompt="Company address (street, suite, city, ST zip)"),

    # ---- Seller (per-instance blanks) ----
    dict(name="sellerName", group=G_SELLER, kind="text", blank=True, default="",
         prompt="Seller name"),
    dict(name="sellerType", group=G_SELLER, kind="text", blank=True, default="",
         prompt="Seller type (e.g. an individual / a Colorado limited liability company)"),
    dict(name="sellerAddress", group=G_SELLER, kind="text", blank=True, default="",
         blank_width="3cm", prompt="Seller address (street, suite, city, ST zip)"),

    # ---- Deal terms ----
    dict(name="effectiveDate", group=G_DEAL, kind="date", default="",
         prompt="Effective Date (MM/DD/YYYY)"),
    dict(name="purchasePrice", group=G_DEAL, kind="money_simple", default="",
         prompt="Purchase Price (e.g. 25000)"),
    dict(name="deliveryDate", group=G_DEAL, kind="date", default="",
         prompt="Delivery date (MM/DD/YYYY)"),
    dict(name="deliveryPlace", group=G_DEAL, kind="text", blank=True, default="",
         prompt="Delivery place / location"),

    # ---- Assets ----
    dict(name="excludedAssets", group=G_ASSETS, kind="text", blank=True, default="",
         prompt="Excluded Assets (leave blank for none)"),
    dict(name="permittedLiens", group=G_ASSETS, kind="text", blank=True, default="",
         prompt="Permitted liens / exceptions to clear title (leave blank for none)"),

    # ---- Governing law / taxes ----
    dict(name="taxParty", group=G_LEGAL, kind="text", blank=True, default="",
         prompt="Party responsible for taxes/fees (e.g. Seller / the Company)"),
    dict(name="venueCounty", group=G_LEGAL, kind="text", blank=True, default="",
         prompt="Venue county (courts located in ___ County)"),

    # ---- Signatures (per-instance blanks) ----
    dict(name="sellerSignByName", group=G_SIG, kind="text", blank=True, default="",
         prompt="Seller — signatory name (By, if entity)", blank_width="4cm"),
    dict(name="sellerSignName", group=G_SIG, kind="text", blank=True, default="",
         prompt="Seller — printed Name", blank_width="4cm"),
    dict(name="sellerSignTitle", group=G_SIG, kind="text", blank=True, default="",
         prompt="Seller — Title", blank_width="4cm"),
    dict(name="sellerSignDate", group=G_SIG, kind="date", default="",
         prompt="Seller — signature Date (MM/DD/YYYY)"),

    dict(name="companySignBy", group=G_SIG, kind="text", blank=True, default="",
         prompt="Company — signatory (By)", blank_width="4cm"),
    dict(name="companySignName", group=G_SIG, kind="text", blank=True, default="",
         prompt="Company — printed Name", blank_width="4cm"),
    dict(name="companySignTitle", group=G_SIG, kind="text", blank=True, default="",
         prompt="Company — Title", blank_width="4cm"),
    dict(name="companySignDate", group=G_SIG, kind="date", default="",
         prompt="Company — signature Date (MM/DD/YYYY)"),
]

# Flat document: no toggleable node tree, no defined terms.
NODES = []
DEFINED_TERMS = {}

SUMMARY_FIELDS = [
    ("Seller", "sellerName"),
    ("Effective Date", "effectiveDate"),
    ("Purchase Price", "purchasePrice"),
    ("Delivery date", "deliveryDate"),
    ("Venue county", "venueCounty"),
    ("Taxes paid by", "taxParty"),
]
