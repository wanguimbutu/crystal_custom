# Copyright (c) 2025, Crystal Customizations
# License: MIT
# Outstanding Debts Report with SQL-level Sales Person Filtering

import frappe
from frappe import _
from frappe.utils import flt, getdate
from collections import OrderedDict

def execute(filters=None):
    if not filters:
        filters = {}
    
    columns = get_columns(filters)
    data = get_data(filters)
    
    return columns, data

def get_columns(filters):
    """Define report columns dynamically based on months with data"""
    
    # Get filters with defaults
    company = filters.get("company") or frappe.defaults.get_user_default("Company")
    from_date = filters.get("from_date")
    to_date = getdate(filters.get("to_date") or frappe.utils.today())
    sales_person_filter = filters.get("sales_person")
    
    # Build sales person filter condition for invoices
    sales_person_join = ""
    sales_person_condition = ""
    if sales_person_filter:
        sales_person_join = """
            INNER JOIN `tabSales Team` st_filter 
                ON st_filter.parent = si.customer 
                AND st_filter.parenttype = 'Customer'
        """
        sales_person_condition = " AND st_filter.sales_person = %(sales_person_filter)s"
    
    # Get all unique month-years from invoices that have outstanding
    from_date_condition = " AND si.posting_date >= %(from_date)s" if from_date else ""
    
    month_years = frappe.db.sql("""
        SELECT DISTINCT 
            DATE_FORMAT(si.posting_date, '%%Y-%%m') as month_year,
            DATE_FORMAT(si.posting_date, '%%b %%Y') as display_month
        FROM 
            `tabSales Invoice` si
            {sales_person_join}
        WHERE 
            si.docstatus = 1
            AND si.company = %(company)s
            AND si.posting_date <= %(to_date)s
            {from_date_condition}
            {sales_person_condition}
        ORDER BY 
            month_year ASC
    """.format(
        sales_person_join=sales_person_join,
        from_date_condition=from_date_condition,
        sales_person_condition=sales_person_condition
    ), {
        "company": company,
        "from_date": from_date,
        "to_date": to_date,
        "sales_person_filter": sales_person_filter
    }, as_dict=1)
    
    # Also get month-years from journal entries
    je_sales_person_join = ""
    je_sales_person_condition = ""
    if sales_person_filter:
        je_sales_person_join = """
            INNER JOIN `tabSales Team` st_filter 
                ON st_filter.parent = jea.party 
                AND st_filter.parenttype = 'Customer'
        """
        je_sales_person_condition = " AND st_filter.sales_person = %(sales_person_filter)s"
    
    from_date_je_condition = " AND je.posting_date >= %(from_date)s" if from_date else ""
    
    je_month_years = frappe.db.sql("""
        SELECT DISTINCT 
            DATE_FORMAT(je.posting_date, '%%Y-%%m') as month_year,
            DATE_FORMAT(je.posting_date, '%%b %%Y') as display_month
        FROM 
            `tabJournal Entry Account` jea
        INNER JOIN 
            `tabJournal Entry` je ON jea.parent = je.name
            {je_sales_person_join}
        WHERE 
            je.docstatus = 1
            AND jea.party_type = 'Customer'
            AND jea.party IS NOT NULL
            AND je.company = %(company)s
            AND je.posting_date <= %(to_date)s
            {from_date_je_condition}
            AND (jea.reference_type IS NULL OR jea.reference_type != 'Sales Invoice')
            {je_sales_person_condition}
        ORDER BY 
            month_year ASC
    """.format(
        je_sales_person_join=je_sales_person_join,
        from_date_je_condition=from_date_je_condition,
        je_sales_person_condition=je_sales_person_condition
    ), {
        "company": company,
        "from_date": from_date,
        "to_date": to_date,
        "sales_person_filter": sales_person_filter
    }, as_dict=1)
    
    # Combine and deduplicate month-years
    all_month_years = {}
    for row in month_years + je_month_years:
        all_month_years[row.month_year] = row.display_month
    
    # Sort by month_year
    sorted_month_years = OrderedDict(sorted(all_month_years.items()))
    
    # Base columns
    columns = [
        {
            "fieldname": "customer",
            "label": _("Customer"),
            "fieldtype": "Link",
            "options": "Customer",
            "width": 150
        },
        {
            "fieldname": "customer_name",
            "label": _("Customer Name"),
            "fieldtype": "Data",
            "width": 180
        },
        {
            "fieldname": "sales_person",
            "label": _("Sales Person"),
            "fieldtype": "Data",
            "width": 150
        },
        {
            "fieldname": "pdc_amount",
            "label": _("PDC Amount"),
            "fieldtype": "Currency",
            "width": 150
        }
    ]
    
    # Add dynamic month columns
    for month_year, display_month in sorted_month_years.items():
        columns.append({
            "fieldname": f"month_{month_year.replace('-', '_')}",
            "label": _(display_month),
            "fieldtype": "Currency",
            "width": 120
        })
    
    # Summary columns (same as original)
    columns.extend([
        {
            "fieldname": "outstanding_amount",
            "label": _("Outstanding Amount"),
            "fieldtype": "Currency",
            "width": 150
        },
        {
            "fieldname": "advance_amount",
            "label": _("Advance Amount"),
            "fieldtype": "Currency",
            "width": 150
        },
        {
            "fieldname": "credit_note_amount",
            "label": _("Credit Note Amount"),
            "fieldtype": "Currency",
            "width": 150
        },
        {
            "fieldname": "total_outstanding",
            "label": _("Total Outstanding"),
            "fieldtype": "Currency",
            "width": 150
        },
        {
            "fieldname": "net_outstanding",
            "label": _("Net Outstanding"),
            "fieldtype": "Currency",
            "width": 150
        },
        {
            "fieldname": "overdue_amount",
            "label": _("Overdue Amount"),
            "fieldtype": "Currency",
            "width": 150
        }
    ])
    
    return columns

def get_customer_sales_person(customer):
    """Get primary sales person for a customer"""
    sales_team = frappe.db.sql("""
        SELECT st.sales_person
        FROM `tabSales Team` st
        WHERE st.parent = %(customer)s
            AND st.parenttype = 'Customer'
        ORDER BY st.allocated_percentage DESC
        LIMIT 1
    """, {"customer": customer}, as_dict=1)
    
    if sales_team and sales_team[0].sales_person:
        return sales_team[0].sales_person
    
    return ""

def get_customer_pdc_amount(customer, company):
    """Get total PDC (draft payment entries) amount for a customer"""
    pdc_payments = frappe.db.sql("""
        SELECT 
            SUM(pe.paid_amount) as total_pdc
        FROM 
            `tabPayment Entry` pe
        WHERE 
            pe.docstatus = 0
            AND pe.party_type = 'Customer'
            AND pe.party = %(customer)s
            AND pe.payment_type = 'Receive'
            AND pe.company = %(company)s
    """, {
        "customer": customer,
        "company": company
    }, as_dict=1)
    
    return flt(pdc_payments[0].total_pdc) if pdc_payments and pdc_payments[0].total_pdc else 0

def get_data(filters):
    """Get customer outstanding data with SQL-level sales person filtering"""
    
    # Get filters with defaults
    if not filters:
        filters = {}
    
    company = filters.get("company") or frappe.defaults.get_user_default("Company")
    from_date = filters.get("from_date")
    to_date = getdate(filters.get("to_date") or frappe.utils.today())
    sales_person_filter = filters.get("sales_person")
    
    if not company:
        frappe.throw(_("Please select a Company"))
    
    # Initialize data dictionary
    customer_data = {}
    
    # Build filter conditions
    from_date_condition = " AND si.posting_date >= %(from_date)s" if from_date else ""
    from_date_je_condition = " AND je.posting_date >= %(from_date)s" if from_date else ""
    from_date_pe_condition = " AND pe.posting_date >= %(from_date)s" if from_date else ""
    
    # Build sales person filter
    sales_person_join = ""
    sales_person_condition = ""
    if sales_person_filter:
        sales_person_join = """
            INNER JOIN `tabSales Team` st_filter 
                ON st_filter.parent = si.customer 
                AND st_filter.parenttype = 'Customer'
        """
        sales_person_condition = " AND st_filter.sales_person = %(sales_person_filter)s"
    
    conditions = {
        "company": company,
        "from_date": from_date,
        "to_date": to_date,
        "sales_person_filter": sales_person_filter
    }
    
    # 1. SALES INVOICES with sales person filter in SQL
    invoices = frappe.db.sql("""
        SELECT 
            si.customer,
            si.customer_name,
            si.name as invoice_name,
            si.posting_date,
            si.due_date,
            DATE_FORMAT(si.posting_date, '%%Y-%%m') as month_year,
            si.grand_total,
            si.is_return,
            COALESCE((
                SELECT SUM(per.allocated_amount)
                FROM `tabPayment Entry Reference` per
                INNER JOIN `tabPayment Entry` pe ON per.parent = pe.name
                WHERE per.reference_doctype = 'Sales Invoice'
                    AND per.reference_name = si.name
                    AND pe.docstatus = 1
                    AND pe.posting_date <= %(to_date)s
            ), 0) as paid_amount,
            COALESCE((
                SELECT SUM(jea.credit - jea.debit)
                FROM `tabJournal Entry Account` jea
                INNER JOIN `tabJournal Entry` je ON jea.parent = je.name
                WHERE jea.reference_type = 'Sales Invoice'
                    AND jea.reference_name = si.name
                    AND je.docstatus = 1
                    AND je.posting_date <= %(to_date)s
            ), 0) as journal_adjusted
        FROM 
            `tabSales Invoice` si
            {sales_person_join}
        WHERE 
            si.docstatus = 1
            AND si.company = %(company)s
            AND si.posting_date <= %(to_date)s
            {from_date_condition}
            {sales_person_condition}
    """.format(
        sales_person_join=sales_person_join,
        from_date_condition=from_date_condition,
        sales_person_condition=sales_person_condition
    ), conditions, as_dict=1)
    
    for inv in invoices:
        customer = inv.customer
        month_year = inv.month_year
        
        if customer not in customer_data:
            sales_person = get_customer_sales_person(customer)
            pdc_amount = get_customer_pdc_amount(customer, company)
            
            customer_data[customer] = {
                "customer": customer,
                "customer_name": inv.customer_name,
                "sales_person": sales_person,
                "pdc_amount": pdc_amount,
                "months": {},
                "outstanding_amount": 0,
                "advance_amount": 0,
                "credit_note_amount": 0,
                "overdue_amount": 0
            }
        
        # Calculate outstanding as of to_date
        outstanding = flt(inv.grand_total) - flt(inv.paid_amount) - flt(inv.journal_adjusted)
        
        if inv.is_return:
            if outstanding < 0:
                customer_data[customer]["credit_note_amount"] += abs(outstanding)
        else:
            if outstanding > 0:
                customer_data[customer]["outstanding_amount"] += outstanding
                if month_year not in customer_data[customer]["months"]:
                    customer_data[customer]["months"][month_year] = 0
                customer_data[customer]["months"][month_year] += outstanding
                
                # Check if overdue (due_date is before to_date)
                if inv.due_date and getdate(inv.due_date) < to_date:
                    customer_data[customer]["overdue_amount"] += outstanding
                    
            elif outstanding < 0:
                customer_data[customer]["advance_amount"] += abs(outstanding)
    
    # 2. JOURNAL ENTRIES with sales person filter in SQL
    je_sales_person_join = ""
    je_sales_person_condition = ""
    if sales_person_filter:
        je_sales_person_join = """
            INNER JOIN `tabSales Team` st_filter 
                ON st_filter.parent = jea.party 
                AND st_filter.parenttype = 'Customer'
        """
        je_sales_person_condition = " AND st_filter.sales_person = %(sales_person_filter)s"
    
    journal_entries = frappe.db.sql("""
        SELECT 
            jea.party as customer,
            DATE_FORMAT(je.posting_date, '%%Y-%%m') as month_year,
            SUM(jea.debit - jea.credit) as net_amount
        FROM 
            `tabJournal Entry Account` jea
        INNER JOIN 
            `tabJournal Entry` je ON jea.parent = je.name
            {je_sales_person_join}
        WHERE 
            je.docstatus = 1
            AND jea.party_type = 'Customer'
            AND jea.party IS NOT NULL
            AND je.company = %(company)s
            AND je.posting_date <= %(to_date)s
            {from_date_je_condition}
            AND (jea.reference_type IS NULL OR jea.reference_type != 'Sales Invoice')
            {je_sales_person_condition}
        GROUP BY 
            jea.party, month_year
        HAVING 
            net_amount != 0
    """.format(
        je_sales_person_join=je_sales_person_join,
        from_date_je_condition=from_date_je_condition,
        je_sales_person_condition=je_sales_person_condition
    ), conditions, as_dict=1)
    
    for row in journal_entries:
        customer = row.customer
        month_year = row.month_year
        
        if customer not in customer_data:
            customer_name = frappe.db.get_value("Customer", customer, "customer_name")
            sales_person = get_customer_sales_person(customer)
            pdc_amount = get_customer_pdc_amount(customer, company)
            
            customer_data[customer] = {
                "customer": customer,
                "customer_name": customer_name,
                "sales_person": sales_person,
                "pdc_amount": pdc_amount,
                "months": {},
                "outstanding_amount": 0,
                "advance_amount": 0,
                "credit_note_amount": 0,
                "overdue_amount": 0
            }
        
        net_amount = flt(row.net_amount)
        if net_amount > 0:
            customer_data[customer]["outstanding_amount"] += net_amount
            if month_year not in customer_data[customer]["months"]:
                customer_data[customer]["months"][month_year] = 0
            customer_data[customer]["months"][month_year] += net_amount
        else:
            customer_data[customer]["advance_amount"] += abs(net_amount)
    
    # 3. UNALLOCATED PAYMENT ENTRIES with sales person filter in SQL
    pe_sales_person_join = ""
    pe_sales_person_condition = ""
    if sales_person_filter:
        pe_sales_person_join = """
            INNER JOIN `tabSales Team` st_filter 
                ON st_filter.parent = pe.party 
                AND st_filter.parenttype = 'Customer'
        """
        pe_sales_person_condition = " AND st_filter.sales_person = %(sales_person_filter)s"
    
    unallocated_payments = frappe.db.sql("""
        SELECT 
            pe.party as customer,
            pe.name as payment_entry,
            pe.paid_amount,
            COALESCE((
                SELECT SUM(per.allocated_amount)
                FROM `tabPayment Entry Reference` per
                WHERE per.parent = pe.name
            ), 0) as allocated_amount
        FROM 
            `tabPayment Entry` pe
            {pe_sales_person_join}
        WHERE 
            pe.docstatus = 1
            AND pe.party_type = 'Customer'
            AND pe.payment_type = 'Receive'
            AND pe.company = %(company)s
            AND pe.posting_date <= %(to_date)s
            {from_date_pe_condition}
            {pe_sales_person_condition}
    """.format(
        pe_sales_person_join=pe_sales_person_join,
        from_date_pe_condition=from_date_pe_condition,
        pe_sales_person_condition=pe_sales_person_condition
    ), conditions, as_dict=1)
    
    for payment in unallocated_payments:
        customer = payment.customer
        
        if customer not in customer_data:
            customer_name = frappe.db.get_value("Customer", customer, "customer_name")
            sales_person = get_customer_sales_person(customer)
            pdc_amount = get_customer_pdc_amount(customer, company)
            
            customer_data[customer] = {
                "customer": customer,
                "customer_name": customer_name,
                "sales_person": sales_person,
                "pdc_amount": pdc_amount,
                "months": {},
                "outstanding_amount": 0,
                "advance_amount": 0,
                "credit_note_amount": 0,
                "overdue_amount": 0
            }
        
        unallocated = flt(payment.paid_amount) - flt(payment.allocated_amount)
        
        if unallocated > 0:
            customer_data[customer]["advance_amount"] += unallocated
    
    # Prepare final data
    data = []
    for customer, values in customer_data.items():
        total_outstanding = (
            flt(values["outstanding_amount"]) 
            - flt(values["advance_amount"]) 
            - flt(values["credit_note_amount"])
        )
        
        # Calculate net outstanding (total outstanding - PDC)
        net_outstanding = total_outstanding - flt(values["pdc_amount"])
        
        # Include all customers with any balance
        if (values["outstanding_amount"] != 0 or 
            values["advance_amount"] != 0 or 
            values["credit_note_amount"] != 0):
            
            row_data = {
                "customer": values["customer"],
                "customer_name": values["customer_name"],
                "sales_person": values["sales_person"],
                "pdc_amount": flt(values["pdc_amount"], 2),
                "outstanding_amount": flt(values["outstanding_amount"], 2),
                "advance_amount": flt(values["advance_amount"], 2),
                "credit_note_amount": flt(values["credit_note_amount"], 2),
                "total_outstanding": flt(total_outstanding, 2),
                "net_outstanding": flt(net_outstanding, 2),
                "overdue_amount": flt(values["overdue_amount"], 2)
            }
            
            # Add month-wise data
            for month_year, amount in values["months"].items():
                field_name = f"month_{month_year.replace('-', '_')}"
                row_data[field_name] = flt(amount, 2)
            
            data.append(row_data)
    
    # Sort by total outstanding (descending)
    data.sort(key=lambda x: x["total_outstanding"], reverse=True)
    
    return data