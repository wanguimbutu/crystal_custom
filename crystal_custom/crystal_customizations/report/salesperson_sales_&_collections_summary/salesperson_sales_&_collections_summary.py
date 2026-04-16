# Copyright (c) 2026, wangui and contributors
# For license information, please see license.txt

# import frappe


from __future__ import unicode_literals
import frappe
from frappe import _


def execute(filters=None):
    if not filters:
        filters = {}

    if not filters.get("from_date") or not filters.get("to_date"):
        return get_columns(), []

    return get_columns(), get_data(filters)


def get_columns():
    return [
        {"label": _("Sales Person"),      "fieldname": "sales_person",     "fieldtype": "Data",     "width": 180},
        {"label": _("Sales Coordinator"), "fieldname": "sales_coordinator", "fieldtype": "Data",     "width": 180},
        {"label": _("Total Invoiced"),    "fieldname": "total_invoiced",   "fieldtype": "Currency", "width": 150},
        {"label": _("Total Collected"),   "fieldname": "total_collected",  "fieldtype": "Currency", "width": 150},
        {"label": _("Total Bounced"),     "fieldname": "total_bounced",    "fieldtype": "Currency", "width": 150},
        {"label": _("Total Rebanked"),    "fieldname": "total_rebanked",   "fieldtype": "Currency", "width": 150},
        {"label": _("Net Collections"),   "fieldname": "net_collections",  "fieldtype": "Currency", "width": 150},
        {"label": _("PDC Cheques"),        "fieldname": "pdc_cheques",      "fieldtype": "Currency", "width": 150},
    ]


def get_data(filters):
    sales_person_filter = filters.get("sales_person")

    sp_filter_invoice = "AND st.sales_person = %(sales_person)s" if sales_person_filter else ""
    sp_filter_payment = "AND st.sales_person = %(sales_person)s" if sales_person_filter else ""
    sp_filter_gl      = "AND sp.name = %(sales_person)s" if sales_person_filter else ""

    # ── 1. SALES INVOICES ─────────────────────────────────────────────────────
    invoice_rows = frappe.db.sql("""
        SELECT
            st.sales_person,
            sa.parent_sales_person AS sales_coordinator,
            SUM(si.grand_total) AS total_invoiced
        FROM `tabSales Invoice` si
        INNER JOIN `tabSales Team` st
            ON st.parent = si.name AND st.parenttype = 'Sales Invoice'
        LEFT JOIN `tabSales Person` sa ON sa.name = st.sales_person
        WHERE si.docstatus = 1
          AND si.posting_date >= %(from_date)s
          AND si.posting_date <= %(to_date)s
          {sp_filter}
        GROUP BY st.sales_person
    """.format(sp_filter=sp_filter_invoice), filters, as_dict=1)

    # ── 2. PAYMENT ENTRIES ────────────────────────────────────────────────────
    payment_rows = frappe.db.sql("""
        SELECT
            st.sales_person,
            sa.parent_sales_person AS sales_coordinator,
            SUM(pe.paid_amount) AS total_collected
        FROM `tabPayment Entry` pe
        LEFT JOIN `tabSales Team` st
            ON st.parent = pe.party AND st.parenttype = 'Customer'
        LEFT JOIN `tabSales Person` sa ON sa.name = st.sales_person
        WHERE pe.docstatus = 1
          AND pe.payment_type = 'Receive'
          AND pe.posting_date >= %(from_date)s
          AND pe.posting_date <= %(to_date)s
          {sp_filter}
        GROUP BY st.sales_person
    """.format(sp_filter=sp_filter_payment), filters, as_dict=1)

    # ── 3. BOUNCED CHEQUES ────────────────────────────────────────────────────
    bounced_rows = frappe.db.sql("""
        SELECT
            sp.name AS sales_person,
            sp.parent_sales_person AS sales_coordinator,
            SUM(ABS(gl.debit)) AS total_bounced
        FROM (
            SELECT
                gl.voucher_no,
                gl.party,
                gl.debit,
                ROW_NUMBER() OVER (
                    PARTITION BY gl.voucher_no ORDER BY gl.posting_date, gl.name
                ) AS rn
            FROM `tabGL Entry` gl
            WHERE gl.voucher_type = 'Journal Entry'
              AND gl.party_type = 'Customer'
              AND gl.against IN (
                  '213503 - I&M Bank Ltd - CAL',
                  '213501 - Equity Bank -Accra Road - CAL',
                  '502410 - Miscellaneous Income - CAL, 213503 - I&M Bank Ltd - CAL'
              )
              AND gl.posting_date >= %(from_date)s
              AND gl.posting_date <= %(to_date)s
              AND gl.debit <> 0
        ) gl
        LEFT JOIN `tabSales Team` st
            ON st.parent = gl.party AND st.parenttype = 'Customer'
        LEFT JOIN `tabSales Person` sp ON sp.name = st.sales_person
        WHERE gl.rn = 1
          {sp_filter}
        GROUP BY sp.name
    """.format(sp_filter=sp_filter_gl), filters, as_dict=1)

    # ── 4. REBANKED CHEQUES ───────────────────────────────────────────────────
    rebanked_rows = frappe.db.sql("""
        SELECT
            sp.name AS sales_person,
            sp.parent_sales_person AS sales_coordinator,
            SUM(gl.credit) AS total_rebanked
        FROM `tabGL Entry` gl
        LEFT JOIN `tabSales Team` st
            ON st.parent = gl.party AND st.parenttype = 'Customer'
        LEFT JOIN `tabSales Person` sp ON sp.name = st.sales_person
        WHERE gl.voucher_type = 'Journal Entry'
          AND gl.party_type = 'Customer'
          AND gl.against IN (
              '213503 - I&M Bank Ltd - CAL',
              '213501 - Equity Bank -Accra Road - CAL'
          )
          AND gl.posting_date >= %(from_date)s
          AND gl.posting_date <= %(to_date)s
          AND gl.credit <> 0
          {sp_filter}
        GROUP BY sp.name
    """.format(sp_filter=sp_filter_gl), filters, as_dict=1)

    # ── 5. PDC CHEQUES (draft payment entries from to_date onwards) ───────────
    pdc_rows = frappe.db.sql("""
        SELECT
            st.sales_person,
            sa.parent_sales_person AS sales_coordinator,
            SUM(pe.paid_amount) AS pdc_cheques
        FROM `tabPayment Entry` pe
        LEFT JOIN `tabSales Team` st
            ON st.parent = pe.party AND st.parenttype = 'Customer'
        LEFT JOIN `tabSales Person` sa ON sa.name = st.sales_person
        WHERE pe.docstatus = 0
          AND pe.payment_type = 'Receive'
          AND (pe.reference_date >= %(to_date)s OR pe.posting_date >= %(to_date)s)
          {sp_filter}
        GROUP BY st.sales_person
    """.format(sp_filter=sp_filter_payment), filters, as_dict=1)

    # ── MERGE INTO SUMMARY DICT ───────────────────────────────────────────────
    summary = {}

    for row in invoice_rows:
        sp = row.get("sales_person") or "Unassigned"
        if sp not in summary:
            summary[sp] = {
                "sales_person":     sp,
                "sales_coordinator": row.get("sales_coordinator") or "",
                "total_invoiced":   0,
                "total_collected":  0,
                "total_bounced":    0,
                "total_rebanked":   0,
                "pdc_cheques":      0,
            }
        summary[sp]["total_invoiced"] = summary[sp]["total_invoiced"] + (row.get("total_invoiced") or 0)

    for row in payment_rows:
        sp = row.get("sales_person") or "Unassigned"
        if sp not in summary:
            summary[sp] = {
                "sales_person":     sp,
                "sales_coordinator": row.get("sales_coordinator") or "",
                "total_invoiced":   0,
                "total_collected":  0,
                "total_bounced":    0,
                "total_rebanked":   0,
                "pdc_cheques":      0,
            }
        summary[sp]["total_collected"] = summary[sp]["total_collected"] + (row.get("total_collected") or 0)

    for row in bounced_rows:
        sp = row.get("sales_person") or "Unassigned"
        if sp not in summary:
            summary[sp] = {
                "sales_person":     sp,
                "sales_coordinator": row.get("sales_coordinator") or "",
                "total_invoiced":   0,
                "total_collected":  0,
                "total_bounced":    0,
                "total_rebanked":   0,
                "pdc_cheques":      0,
            }
        summary[sp]["total_bounced"] = summary[sp]["total_bounced"] + (row.get("total_bounced") or 0)

    for row in rebanked_rows:
        sp = row.get("sales_person") or "Unassigned"
        if sp not in summary:
            summary[sp] = {
                "sales_person":     sp,
                "sales_coordinator": row.get("sales_coordinator") or "",
                "total_invoiced":   0,
                "total_collected":  0,
                "total_bounced":    0,
                "total_rebanked":   0,
                "pdc_cheques":      0,
            }
        summary[sp]["total_rebanked"] = summary[sp]["total_rebanked"] + (row.get("total_rebanked") or 0)

    for row in pdc_rows:
        sp = row.get("sales_person") or "Unassigned"
        if sp not in summary:
            summary[sp] = {
                "sales_person":     sp,
                "sales_coordinator": row.get("sales_coordinator") or "",
                "total_invoiced":   0,
                "total_collected":  0,
                "total_bounced":    0,
                "total_rebanked":   0,
                "pdc_cheques":      0,
            }
        summary[sp]["pdc_cheques"] = summary[sp]["pdc_cheques"] + (row.get("pdc_cheques") or 0)

    # ── CALCULATE NET & BUILD RESULT ──────────────────────────────────────────
    result = []
    for sp in sorted(summary.keys()):
        row = summary[sp]
        row["net_collections"] = (
            row["total_collected"]
            - row["total_bounced"]
            + row["total_rebanked"]
        )
        result.append(row)

    if result:
        result.append({
            "sales_person":      _("TOTAL"),
            "sales_coordinator": "",
            "total_invoiced":    sum(r["total_invoiced"]  for r in result),
            "total_collected":   sum(r["total_collected"] for r in result),
            "total_bounced":     sum(r["total_bounced"]   for r in result),
            "total_rebanked":    sum(r["total_rebanked"]  for r in result),
            "net_collections":   sum(r["net_collections"] for r in result),
            "pdc_cheques":       sum(r["pdc_cheques"]     for r in result),
        })

    return result