"""Single source of truth for the Commercial Master Lease.

Describes:
  * DEFINED_TERMS  - fixed \\textsc{} legal terms (never prompted; always written verbatim).
  * VARIABLES      - deal fill-ins prompted by the create-lease wizard (grouped, typed, defaulted).
  * RENT_PARAMS    - numeric inputs that drive the auto-generated Exhibit B / D tables.
  * NODES          - the ordered LaTeX node tree (front matter, 27 articles, signatures, exhibits).

Both scripts/scaffold.py (one-time tree creation) and scripts/create_lease.py (the wizard)
import this module so the structure is defined in exactly one place.
"""

# --------------------------------------------------------------------------------------
# Roman numerals for the 27 articles.
# --------------------------------------------------------------------------------------
ROMAN = [
    "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII", "XIII",
    "XIV", "XV", "XVI", "XVII", "XVIII", "XIX", "XX", "XXI", "XXII", "XXIII", "XXIV",
    "XXV", "XXVI", "XXVII",
]

# --------------------------------------------------------------------------------------
# Defined legal terms: key -> display text. render.render_defined_terms() turns each into
# a \<key> command that renders the display in small caps and hyperlinks to its definition
# (marked in the prose with \dtdef{key}). The styling/link machinery lives in style.tex.
# Order = the order terms are first defined in the document (nice for reading the file).
# --------------------------------------------------------------------------------------
DEFINED_TERMS = {
    "lease": "Lease",
    "lessor": "Lessor",
    "lessee": "Lessee",
    "effectiveDate": "Effective Date",
    "basicLeaseInformation": "Basic Lease Information",
    "premises": "Premises",
    "building": "Building",
    "deliveryDate": "Delivery Date",
    "termOfLease": "Term of this Lease",
    "expirationDate": "Expiration Date",
    "rentCommencementDate": "Rent Commencement Date",
    "leaseYear": "Lease Year",
    "optionI": r"Option \#1",
    "optionTermI": r"Option Term \#1",
    "optionII": r"Option \#2",
    "optionTermII": r"Option Term \#2",
    "fairMarketValue": "Fair Market Value",
    "negotiationPeriod": "Negotiation Period",
    "permittedUse": "Permitted Use",
    "commonAreas": "Common Areas",
    "baseMonthlyRent": "Base Monthly Rent",
    "additionalRent": "Additional Rent",
    "monthlyRent": "Monthly Rent",
    "parties": "Parties",
    "lesseesPercentage": "Lessee's Percentage",
    "controllableCAM": "Controllable Common Area Maintenance",
    "hvacMaintenance": "HVAC Maintenance",
    "serviceInterruption": "Service Interruption",
    "premisesImprovements": "Premises Improvements",
    "lesseeImprovements": "Lessee Improvements",
    "improvements": "Improvements",
    "permittedTransfer": "Permitted Transfer",
    "consentTransfer": "Consent Transfer",
    "excessRent": "Excess Rent",
    "totalLoss": "Total Loss",
    "partialLoss": "Partial Loss",
    "eventOfDefault": "Event of Default",
    "environmentalLaws": "Environmental Laws",
    "hazardousSubstances": "Hazardous Substances",
    "guarantor": "Guarantor",
}

# --------------------------------------------------------------------------------------
# Typed deal inputs. The wizard prompts for these; render.derive() turns them into the
# spelled-out \newcommand values the prose uses, and the rent fields also drive Exhibit B/D.
#   kind: text | address | date (MM/DD/YYYY) | floor | count | sqft | money | money_simple
#         | percent | percent_legal | choice (+ "choices")
#   firm=True     -> a firm-wide constant; seeded into settings.json (edit there, not here).
#   same_as="x"   -> the wizard offers to reuse input "x" instead of re-typing.
# Deal-specific fields default to empty / 0; the wizard prompt explains the format.
# --------------------------------------------------------------------------------------
G_LESSOR = "Lessor (your firm)"
G_LESSEE = "Lessee"
G_PREMISES = "Premises & Building"
G_TERM = "Dates & Term"
G_USE = "Use"
G_FINANCIAL = "Financial terms"
G_EXHIBITC = "Exhibit C — additional rent estimate"
G_ABATE = "Rent abatement (Exhibit D)"
G_SIGN = "Signatures"
G_GUARANTY = "Guaranty (Exhibit F)"
G_LAW = "Governing law"

INPUTS = [
    # Lessor (firm constants are seeded into settings.json)
    dict(name="lessorName", group=G_LESSOR, kind="text", default="", prompt="Lessor entity name (e.g. Acme Holdings, LLC)"),
    dict(name="lessorType", group=G_LESSOR, kind="text", firm=True, default="an Illinois limited liability company", prompt="Lessor entity type"),
    dict(name="lessorAddress", group=G_LESSOR, kind="address", firm=True, default="501 W. State Street, Suite 206, Geneva, IL 60134", prompt="Lessor address"),
    dict(name="lessorEmail", group=G_LESSOR, kind="text", firm=True, default="cjcalamos@nkcfo.com", prompt="Lessor notice email"),
    dict(name="lessorCounselName", group=G_LESSOR, kind="text", firm=True, default="Kuhn, Heap & Monson", prompt="Lessor counsel (copy-to) firm"),
    dict(name="lessorCounselAttn", group=G_LESSOR, kind="text", firm=True, default="Attn: Len Monson", prompt="Lessor counsel attention line"),
    dict(name="lessorCounselAddress", group=G_LESSOR, kind="address", firm=True, default="552 S. Washington Street, Suite 100, Naperville, IL 60510", prompt="Lessor counsel address"),
    dict(name="lessorCounselEmail", group=G_LESSOR, kind="text", firm=True, default="len@kuhnheap.com", prompt="Lessor counsel email"),

    # Lessee
    dict(name="lesseeName", group=G_LESSEE, kind="text", default="", prompt="Lessee entity name"),
    dict(name="lesseeType", group=G_LESSEE, kind="text", default="a limited liability company", prompt="Lessee entity type (e.g. an Illinois limited liability company)"),
    dict(name="lesseeAddress", group=G_LESSEE, kind="address", default="", prompt="Lessee principal location"),
    dict(name="lesseeNoticeAddress", group=G_LESSEE, kind="address", same_as="lesseeAddress", default="", prompt="Lessee notice address"),
    dict(name="lesseeEmail", group=G_LESSEE, kind="text", default="", prompt="Lessee notice email"),

    # Premises & Building — enter plain numbers; they are spelled out + parenthesized
    dict(name="premisesRSF", group=G_PREMISES, kind="sqft", default="", prompt="Premises rentable square feet (just the number)"),
    dict(name="premisesFloor", group=G_PREMISES, kind="floor", default=1, prompt="Premises floor (just the number)"),
    dict(name="premisesBasementSF", group=G_PREMISES, kind="sqft", default=0, prompt="Basement square feet (0 if none)"),
    dict(name="buildingStories", group=G_PREMISES, kind="count", default=1, prompt="Building stories (just the number)"),
    dict(name="buildingRSF", group=G_PREMISES, kind="sqft", default="", prompt="Building total rentable square feet (number)"),
    dict(name="buildingAddress", group=G_PREMISES, kind="address", default="", prompt="Building address"),
    dict(name="buildingTotalRSF", group=G_PREMISES, kind="sqft", default="", prompt="RSF basis for Lessee's Percentage (number)"),

    # Dates (MM/DD/YYYY) & term
    dict(name="effectiveDate", group=G_TERM, kind="date", default="", prompt="Effective date (MM/DD/YYYY)"),
    dict(name="deliveryDate", group=G_TERM, kind="date", default="", prompt="Delivery date (MM/DD/YYYY)"),
    dict(name="leaseCommencementDate", group=G_TERM, kind="date", default="", prompt="Lease Commencement Date (MM/DD/YYYY)"),
    dict(name="rentCommencementDate", group=G_TERM, kind="date", default="", prompt="Rent Commencement Date (MM/DD/YYYY) — anchors Exhibit B"),
    dict(name="expirationDate", group=G_TERM, kind="date", default="", prompt="Expiration date (MM/DD/YYYY)"),
    dict(name="termYears", group=G_TERM, kind="count", default="", prompt="Initial term, in years (number)"),
    dict(name="optionILengthYears", group=G_TERM, kind="count", default=0, prompt="Option Term #1 length in years (0 to omit)"),
    dict(name="optionIILengthYears", group=G_TERM, kind="count", default=0, prompt="Option Term #2 length in years (0 to omit)"),

    # Use
    dict(name="permittedUsePrimary", group=G_USE, kind="text", default="", prompt="Primary permitted use"),
    dict(name="permittedUseSecondary", group=G_USE, kind="text", default="", prompt="Secondary permitted use"),

    # Financial — enter plain dollar / percent numbers
    dict(name="leaseType", group=G_FINANCIAL, kind="choice",
         choices=["Gross: CAM, Insurance, and Property Taxes are included in the Base Monthly Rent",
                  "Triple Net (NNN): Additional Rent as defined herein shall be due."],
         default="Triple Net (NNN): Additional Rent as defined herein shall be due.",
         prompt="Lease type"),
    dict(name="baseRentPerSF", group=G_FINANCIAL, kind="money", default="", prompt="Base rent, $ per rentable square foot (just the number)"),
    dict(name="year1MonthlyBaseRent", group=G_FINANCIAL, kind="money", default="", prompt="Lease Year 1 monthly base rent ($, number) — drives Exhibit B"),
    dict(name="annualIncreasePct", group=G_FINANCIAL, kind="percent", default=3, prompt="Annual base-rent increase (%, just the number)"),
    dict(name="lesseesPercentage", group=G_FINANCIAL, kind="percent_legal", default="", prompt="Lessee's Percentage (%, just the number)"),
    dict(name="securityDepositMonths", group=G_FINANCIAL, kind="count", default=1, prompt="Security deposit, in months of base rent"),
    dict(name="securityDepositAmount", group=G_FINANCIAL, kind="money", default="", prompt="Security deposit amount ($, number)"),
    dict(name="lesseeAllowancePerSF", group=G_FINANCIAL, kind="money", default="", prompt="Lessee allowance, $ per square foot (number)"),
    dict(name="lesseeAllowanceTotal", group=G_FINANCIAL, kind="money", default="", prompt="Lessee allowance, total ($, number)"),
    dict(name="brokerName", group=G_FINANCIAL, kind="text", default="", prompt="Lessee's broker"),

    # Exhibit C — additional rent estimate ($/sq ft)
    dict(name="addRentTaxes", group=G_EXHIBITC, kind="money_simple", default="", prompt="Real estate taxes, $/sq ft/yr (number)"),
    dict(name="addRentInsurance", group=G_EXHIBITC, kind="money_simple", default="", prompt="Insurance premiums, $/sq ft/yr (number)"),
    dict(name="addRentCAM", group=G_EXHIBITC, kind="money_simple", default="", prompt="Common Area Maintenance, $/sq ft/yr (number)"),

    # Rent abatement (Exhibit D)
    dict(name="abatementMode", group=G_ABATE, kind="choice",
         choices=["none", "upfront", "spread", "end"], default="none",
         prompt="Abatement structure (upfront / spread = one month per Lease Year / end of term)"),
    dict(name="freeRentMonths", group=G_ABATE, kind="count", default=0, prompt="Number of abated/free months (0 if none)"),
    dict(name="abatementStartDate", group=G_ABATE, kind="date", same_as="rentCommencementDate", default="", prompt="Abatement start date (MM/DD/YYYY, for 'upfront')"),

    # Signatures
    dict(name="lessorSigner", group=G_SIGN, kind="text", default="", prompt="Lessor signatory name"),
    dict(name="lessorSignerTitle", group=G_SIGN, kind="text", default="", prompt="Lessor signatory title"),
    dict(name="lesseeSigner", group=G_SIGN, kind="text", default="", prompt="Lessee signatory name"),
    dict(name="lesseeSignerTitle", group=G_SIGN, kind="text", default="", prompt="Lessee signatory title"),

    # Guaranty (Exhibit F)
    dict(name="guarantorName", group=G_GUARANTY, kind="text", default="", prompt="Guarantor name"),
    dict(name="guarantorSigner", group=G_GUARANTY, kind="text", default="", prompt="Guarantor signatory (print name)"),
    dict(name="guarantorAddress", group=G_GUARANTY, kind="address", default="", prompt="Guarantor address"),
    dict(name="guarantorPhone", group=G_GUARANTY, kind="text", default="", prompt="Guarantor phone"),

    # Governing law (firm constants)
    dict(name="governingState", group=G_LAW, kind="text", firm=True, default="Illinois", prompt="Governing-law state"),
    dict(name="governingCounty", group=G_LAW, kind="text", firm=True, default="Kane County", prompt="Exclusive-jurisdiction county"),
]


# --------------------------------------------------------------------------------------
# Node tree. Order is document order. Nesting is encoded by `path`.
#   htype: article (\section) | section (\subsection) | subsection (\subsubsection)
#          | bli | witnesseth | signatures | exhibit
#   boolean:   the \newboolean / \setboolean name
#   label:     heading text (from the source Table of Contents)
#   ref:       optional \label{...} key (cross-reference target)
#   header_only: parent whose body is only its children (a bare "." in the source)
#   lead_in:   parent that has its own lead-in paragraph AND children (e.g. 21.2)
#   letter:    exhibit letter (exhibit nodes only)
# --------------------------------------------------------------------------------------
def _n(path, boolean, htype, label, ref=None, header_only=False, lead_in=False, letter=None):
    return dict(path=path, boolean=boolean, htype=htype, label=label, ref=ref,
                header_only=header_only, lead_in=lead_in, letter=letter)


NODES = [
    # ---- Front matter (no article number; precede the TOC) ----
    _n("basic_lease_information", "includeBLI", "bli", "Basic Lease Information"),
    _n("witnesseth", "includeWitnesseth", "witnesseth", "Witnesseth"),

    # ---- Article I — Leased Premises ----
    _n("article_i", "includeI", "article", "Leased Premises"),
    _n("article_i/section_1", "include1_1", "section", "Leased Premises"),

    # ---- Article II — Commencement and Ending Date of Term ----
    _n("article_ii", "includeII", "article", "Commencement and Ending Date of Term"),
    _n("article_ii/section_1", "include2_1", "section", "Delivery Date"),
    _n("article_ii/section_2", "include2_2", "section", "Rent Commencement Date", ref="sec:rent-commencement"),
    _n("article_ii/section_3", "include2_3", "section", "Lease Year", ref="sec:lease-year"),
    _n("article_ii/section_4", "include2_4", "section", "Option Term \\#1", ref="sec:option-i"),
    _n("article_ii/section_5", "include2_5", "section", "Option Term \\#2", ref="sec:option-ii"),
    _n("article_ii/section_6", "include2_6", "section", "Fair Market Value", ref="sec:fair-market-value", header_only=True),
    _n("article_ii/section_6/subsection_1", "include2_6_1", "subsection", "Definition"),
    _n("article_ii/section_6/subsection_2", "include2_6_2", "subsection", "Negotiation Period"),

    # ---- Article III — Use of Premises ----
    _n("article_iii", "includeIII", "article", "Use of Premises"),
    _n("article_iii/section_1", "include3_1", "section", "Permitted Use"),
    _n("article_iii/section_2", "include3_2", "section", "Use of Additional Area"),

    # ---- Article IV — Rent ----
    _n("article_iv", "includeIV", "article", "Rent"),
    _n("article_iv/section_1", "include4_1", "section", "Monthly Rent"),
    _n("article_iv/section_2", "include4_2", "section", "Late Payments"),
    _n("article_iv/section_3", "include4_3", "section", "Rent Abatement"),

    # ---- Article V — Security Deposit ----
    _n("article_v", "includeV", "article", "Security Deposit"),
    _n("article_v/section_1", "include5_1", "section", "Security Deposit"),

    # ---- Article VI — Lessee's Percentage ----
    _n("article_vi", "includeVI", "article", "Lessee's Percentage"),
    _n("article_vi/section_1", "include6_1", "section", "Lessee's Percentage"),

    # ---- Article VII — Additional Rent (the 3-level article) ----
    _n("article_vii", "includeVII", "article", "Additional Rent"),
    _n("article_vii/section_1", "include7_1", "section", "Real Estate Taxes", ref="sec:real-estate-taxes"),
    _n("article_vii/section_2", "include7_2", "section", "Insurance; Waiver of Subrogation", ref="sec:insurance", header_only=True),
    _n("article_vii/section_2/subsection_1", "include7_2_1", "subsection", "Lessee's Insurance"),
    _n("article_vii/section_2/subsection_2", "include7_2_2", "subsection", "Lessor's Insurance"),
    _n("article_vii/section_2/subsection_3", "include7_2_3", "subsection", "Waiver of Subrogation"),
    _n("article_vii/section_3", "include7_3", "section", "Common Area Maintenance", ref="sec:cam", header_only=True),
    _n("article_vii/section_3/subsection_1", "include7_3_1", "subsection", "Definition"),
    _n("article_vii/section_3/subsection_2", "include7_3_2", "subsection", "Exclusions"),
    _n("article_vii/section_3/subsection_3", "include7_3_3", "subsection", "Controllable Common Area Maintenance"),
    _n("article_vii/section_4", "include7_4", "section", "Utilities", ref="sec:utilities", header_only=True),
    _n("article_vii/section_4/subsection_1", "include7_4_1", "subsection", "Utilities"),
    _n("article_vii/section_4/subsection_2", "include7_4_2", "subsection", "Interruption of Services"),
    _n("article_vii/section_5", "include7_5", "section", "HVAC Maintenance", ref="sec:hvac"),
    _n("article_vii/section_6", "include7_6", "section", "Estimated Payments", ref="sec:estimated-payments", header_only=True),
    _n("article_vii/section_6/subsection_1", "include7_6_1", "subsection", "Annual Statement; Reconciliation"),
    _n("article_vii/section_6/subsection_2", "include7_6_2", "subsection", "Books and Records; Audit"),

    # ---- Article VIII — Improvements ----
    _n("article_viii", "includeVIII", "article", "Improvements"),
    _n("article_viii/section_1", "include8_1", "section", "Lessor Improvements"),
    _n("article_viii/section_2", "include8_2", "section", "Lessee Improvements and Allowance"),
    _n("article_viii/section_3", "include8_3", "section", "Ownership of Improvements"),

    # ---- Article IX — Repair and Maintenance ----
    _n("article_ix", "includeIX", "article", "Repair and Maintenance"),
    _n("article_ix/section_1", "include9_1", "section", "Lessee's Repair and Maintenance Obligations"),
    _n("article_ix/section_2", "include9_2", "section", "Lessor's Repair and Maintenance Obligations"),

    # ---- Article X — Sublease; Assignment ----
    _n("article_x", "includeX", "article", "Sublease; Assignment"),
    _n("article_x/section_1", "include10_1", "section", "Permitted Transfer"),
    _n("article_x/section_2", "include10_2", "section", "Consent Transfer"),
    _n("article_x/section_3", "include10_3", "section", "Excess Rent"),
    _n("article_x/section_4", "include10_4", "section", "Liability"),

    # ---- Article XI — Mechanic's Liens ----
    _n("article_xi", "includeXI", "article", "Mechanic's Liens"),
    _n("article_xi/section_1", "include11_1", "section", "Mechanic's Liens"),

    # ---- Article XII — Indemnity for Accidents ----
    _n("article_xii", "includeXII", "article", "Indemnity for Accidents"),
    _n("article_xii/section_1", "include12_1", "section", "Non-Liability of Lessor"),
    _n("article_xii/section_2", "include12_2", "section", "Non-Liability of Lessee"),

    # ---- Article XIII — Access to Premises ----
    _n("article_xiii", "includeXIII", "article", "Access to Premises"),
    _n("article_xiii/section_1", "include13_1", "section", "Access to Leased Premises"),

    # ---- Article XIV — Holding Over ----
    _n("article_xiv", "includeXIV", "article", "Holding Over"),
    _n("article_xiv/section_1", "include14_1", "section", "Holding Over"),

    # ---- Article XV — Rent Deduction ----
    _n("article_xv", "includeXV", "article", "Rent Deduction"),
    _n("article_xv/section_1", "include15_1", "section", "No Rent Deduction or Set Off"),

    # ---- Article XVI — Litigation ----
    _n("article_xvi", "includeXVI", "article", "Litigation"),
    _n("article_xvi/section_1", "include16_1", "section", "Recovery"),

    # ---- Article XVII — Untenability ----
    _n("article_xvii", "includeXVII", "article", "Untenability"),
    _n("article_xvii/section_1", "include17_1", "section", "Definitions"),
    _n("article_xvii/section_2", "include17_2", "section", "Total Loss", ref="sec:total-loss"),
    _n("article_xvii/section_3", "include17_3", "section", "Partial Loss"),

    # ---- Article XVIII — Subordination ----
    _n("article_xviii", "includeXVIII", "article", "Subordination"),
    _n("article_xviii/section_1", "include18_1", "section", "Estoppel Certificate"),

    # ---- Article XIX — Signs ----
    _n("article_xix", "includeXIX", "article", "Signs"),
    _n("article_xix/section_1", "include19_1", "section", "Approved Signage"),

    # ---- Article XX — Alterations ----
    _n("article_xx", "includeXX", "article", "Alterations"),
    _n("article_xx/section_1", "include20_1", "section", "Alterations"),

    # ---- Article XXI — Events of Default ----
    _n("article_xxi", "includeXXI", "article", "Events of Default"),
    _n("article_xxi/section_1", "include21_1", "section", "Definition"),
    _n("article_xxi/section_2", "include21_2", "section", "Lessor's Remedies", lead_in=True),
    _n("article_xxi/section_2/subsection_1", "include21_2_1", "subsection", "Recoveries"),
    _n("article_xxi/section_2/subsection_2", "include21_2_2", "subsection", "Relet", ref="sec:relet"),
    _n("article_xxi/section_2/subsection_3", "include21_2_3", "subsection", "Default", ref="sec:default-perform"),
    _n("article_xxi/section_3", "include21_3", "section", "Lessor's Right to File Suit"),
    _n("article_xxi/section_4", "include21_4", "section", "No Waiver of Lessor's Rights"),

    # ---- Article XXII — Notices ----
    _n("article_xxii", "includeXXII", "article", "Notices"),
    _n("article_xxii/section_1", "include22_1", "section", "Notices", ref="sec:notices"),

    # ---- Article XXIII — Eminent Domain ----
    _n("article_xxiii", "includeXXIII", "article", "Eminent Domain"),
    _n("article_xxiii/section_1", "include23_1", "section", "Eminent Domain"),

    # ---- Article XXIV — Quiet Enjoyment ----
    _n("article_xxiv", "includeXXIV", "article", "Quiet Enjoyment"),
    _n("article_xxiv/section_1", "include24_1", "section", "Quiet Enjoyment"),

    # ---- Article XXV — Rules and Regulations ----
    _n("article_xxv", "includeXXV", "article", "Rules and Regulations"),
    _n("article_xxv/section_1", "include25_1", "section", "Rules and Regulations"),

    # ---- Article XXVI — Environmental Restrictions ----
    _n("article_xxvi", "includeXXVI", "article", "Environmental Restrictions"),
    _n("article_xxvi/section_1", "include26_1", "section", "Environmental Laws"),
    _n("article_xxvi/section_2", "include26_2", "section", "Lessee's Responsibility", ref="sec:env-responsibility"),
    _n("article_xxvi/section_3", "include26_3", "section", "Indemnification of Lessor"),

    # ---- Article XXVII — Miscellaneous ----
    _n("article_xxvii", "includeXXVII", "article", "Miscellaneous"),
    _n("article_xxvii/section_1", "include27_1", "section", "Time is of the Essence"),
    _n("article_xxvii/section_2", "include27_2", "section", "Binding Effect"),
    _n("article_xxvii/section_3", "include27_3", "section", "Entire Agreement"),
    _n("article_xxvii/section_4", "include27_4", "section", "Captions; Titles"),
    _n("article_xxvii/section_5", "include27_5", "section", "Governing Law"),
    _n("article_xxvii/section_6", "include27_6", "section", "Force Majeure", ref="sec:force-majeure"),
    _n("article_xxvii/section_7", "include27_7", "section", "Confidentiality", header_only=True),
    _n("article_xxvii/section_7/subsection_1", "include27_7_1", "subsection", "General"),
    _n("article_xxvii/section_7/subsection_2", "include27_7_2", "subsection", "Lessee's Business"),
    _n("article_xxvii/section_8", "include27_8", "section", "Broker's Fee"),
    _n("article_xxvii/section_9", "include27_9", "section", "Counterparts; Electronic Signatures"),

    # ---- Signatures ----
    _n("signatures", "includeSignatures", "signatures", "Signatures"),

    # ---- Exhibits ----
    _n("exhibit_a", "includeExhibitA", "exhibit", "Description of Premises", letter="A"),
    _n("exhibit_b", "includeExhibitB", "exhibit", "Monthly Rent", letter="B"),
    _n("exhibit_c", "includeExhibitC", "exhibit", "Estimate of Additional Rent", letter="C"),
    _n("exhibit_d", "includeExhibitD", "exhibit", "Rent Abatement Schedule", letter="D"),
    _n("exhibit_e", "includeExhibitE", "exhibit", "Premises Improvements", letter="E"),
    _n("exhibit_f", "includeExhibitF", "exhibit", "Personal Guaranty", letter="F"),
]

# Content files regenerated by the wizard (computed tables). Everything else is hand prose.
GENERATED_CONTENT = {"exhibit_b", "exhibit_d"}

# Heading-level cross-reference: stale flat ref in the source -> our \label key.
# Provided to the transcription step so "Section 1.x" becomes Section~\ref{key}.
CROSSREF_MAP = {
    "1.3": "sec:rent-commencement",
    "1.5": "sec:option-i",
    "1.6": "sec:option-ii",
    "1.7": "sec:fair-market-value",
    "1.15": "sec:real-estate-taxes",
    "1.16": "sec:insurance",
    "1.17": "sec:cam",
    "1.18": "sec:utilities",
    "1.19": "sec:hvac",
    "1.20": "sec:estimated-payments",
    "1.44.2": "sec:relet",
    "1.45": "sec:default-perform",
    "1.47": "sec:notices",
    "1.53": "sec:env-responsibility",
    "1.59": "sec:force-majeure",
}


# --------------------------------------------------------------------------------------
# Derived helpers.
# --------------------------------------------------------------------------------------
def node_by_path(path):
    for n in NODES:
        if n["path"] == path:
            return n
    return None


def children_of(path):
    """Direct children (one path component deeper), in document order."""
    depth = path.count("/") + 1
    return [n for n in NODES
            if n["path"].startswith(path + "/") and n["path"].count("/") == depth]


def top_level_nodes():
    """Nodes with no parent (peers imported directly by src/content.tex)."""
    return [n for n in NODES if "/" not in n["path"]]


def all_booleans():
    return [n["boolean"] for n in NODES]
