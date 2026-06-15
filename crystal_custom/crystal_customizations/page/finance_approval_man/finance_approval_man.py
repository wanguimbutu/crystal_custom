import frappe
from frappe.utils import nowdate, flt


@frappe.whitelist()
def get_customer_financial_summary(customers):
	"""
	Batch-load financial data for a list of customers.
	Returns a dict keyed by customer name with outstanding, overdue,
	payment_terms, credit_limit, and PDC cheque info.
	"""
	if isinstance(customers, str):
		import json
		customers = json.loads(customers)

	if not customers:
		return {}

	today = nowdate()
	placeholders = ", ".join(["%s"] * len(customers))

	# ── Outstanding + Overdue + Aging from Sales Invoices ───────────────────
	invoice_rows = frappe.db.sql(
		f"""
		SELECT
			customer,
			IFNULL(SUM(outstanding_amount), 0) AS outstanding,
			IFNULL(SUM(CASE WHEN due_date < %s THEN outstanding_amount ELSE 0 END), 0) AS overdue,
			IFNULL(SUM(CASE WHEN due_date < %s AND DATEDIFF(%s, due_date) BETWEEN 1  AND 30  THEN outstanding_amount ELSE 0 END), 0) AS aging_0_30,
			IFNULL(SUM(CASE WHEN due_date < %s AND DATEDIFF(%s, due_date) BETWEEN 31 AND 60  THEN outstanding_amount ELSE 0 END), 0) AS aging_31_60,
			IFNULL(SUM(CASE WHEN due_date < %s AND DATEDIFF(%s, due_date) BETWEEN 61 AND 90  THEN outstanding_amount ELSE 0 END), 0) AS aging_61_90,
			IFNULL(SUM(CASE WHEN due_date < %s AND DATEDIFF(%s, due_date) > 90               THEN outstanding_amount ELSE 0 END), 0) AS aging_90_plus
		FROM `tabSales Invoice`
		WHERE customer IN ({placeholders})
		  AND docstatus = 1
		  AND outstanding_amount > 0
		GROUP BY customer
		""",
		[today, today, today, today, today, today, today, today, today] + customers,
		as_dict=1,
	)
	inv_map = {r.customer: r for r in invoice_rows}

	# ── Credit Limits ────────────────────────────────────────────────────────
	credit_rows = frappe.db.sql(
		f"""
		SELECT parent AS customer, MAX(credit_limit) AS credit_limit
		FROM `tabCustomer Credit Limit`
		WHERE parent IN ({placeholders})
		GROUP BY parent
		""",
		customers,
		as_dict=1,
	)
	credit_map = {r.customer: flt(r.credit_limit) for r in credit_rows}

	# ── Payment Terms ────────────────────────────────────────────────────────
	terms_rows = frappe.db.sql(
		f"""
		SELECT name, payment_terms
		FROM `tabCustomer`
		WHERE name IN ({placeholders})
		""",
		customers,
		as_dict=1,
	)
	terms_map = {r.name: r.payment_terms or "" for r in terms_rows}

	# ── Upcoming payments: draft or submitted PEs with posting_date >= today ────
	# Submitted entries with future dates are ERPNext's standard PDC model.
	# docstatus = 2 (cancelled) is excluded; past-dated entries are excluded.
	pdc_rows = frappe.db.sql(
		f"""
		SELECT
			party                           AS customer,
			COUNT(*)                        AS pdc_count,
			IFNULL(SUM(paid_amount), 0)     AS pdc_amount
		FROM `tabPayment Entry`
		WHERE party_type  = 'Customer'
		  AND party IN ({placeholders})
		  AND docstatus   IN (0, 1)
		  AND posting_date >= %s
		GROUP BY party
		""",
		customers + [today],
		as_dict=1,
	)
	pdc_map = {r.customer: r for r in pdc_rows}

	# ── Assemble result ──────────────────────────────────────────────────────
	result = {}
	for customer in customers:
		inv = inv_map.get(customer, {})
		pdc = pdc_map.get(customer, {})
		result[customer] = {
			"outstanding":  flt(inv.get("outstanding", 0)),
			"overdue":      flt(inv.get("overdue", 0)),
			"aging_0_30":   flt(inv.get("aging_0_30", 0)),
			"aging_31_60":  flt(inv.get("aging_31_60", 0)),
			"aging_61_90":  flt(inv.get("aging_61_90", 0)),
			"aging_90_plus": flt(inv.get("aging_90_plus", 0)),
			"credit_limit": credit_map.get(customer, 0),
			"payment_terms": terms_map.get(customer, ""),
			"pdc_count":    int(pdc.get("pdc_count", 0)),
			"pdc_amount":   flt(pdc.get("pdc_amount", 0)),
		}

	return result


@frappe.whitelist()
def approve_orders(order_names):
    """
    Move orders from Pending Finance Approval → Pending Customer Order Reconfirmation
    using a direct DB write to avoid workflow auto-transitions.
    Also clears any finance rejection note from a previous rejection.
    """
    import json

    if isinstance(order_names, str):
        order_names = json.loads(order_names)

    updated, skipped = [], []
    for name in order_names:
        state = frappe.db.get_value('Sales Order', name, 'workflow_state')
        if state != 'Pending Finance Approval':
            skipped.append(name)
            continue
        frappe.db.set_value(
            'Sales Order', name,
            {
                'workflow_state': 'Pending Customer Order Reconfirmation',
                'custom_finance_rejection_note': '',
                'custom_resubmission_note': '',
            },
            update_modified=False,
        )
        updated.append(name)

    if updated:
        frappe.db.commit()
    return {'updated': updated, 'skipped': skipped}


@frappe.whitelist()
def reject_order_state(order_name, reason):
    """
    Move a single order from Pending Finance Approval back to Proceed To Order
    and record the rejection reason — direct DB write, no workflow engine.
    """
    state = frappe.db.get_value('Sales Order', order_name, 'workflow_state')
    if state != 'Pending Finance Approval':
        frappe.throw(f'{order_name} is not at Pending Finance Approval (current: {state})')
    frappe.db.set_value(
        'Sales Order', order_name,
        {
            'workflow_state': 'Proceed To Order',
            'custom_finance_rejection_note': reason,
            'custom_resubmission_note': '',
        },
        update_modified=False,
    )
    frappe.db.commit()
    return True


@frappe.whitelist()
def notify_rejection(order_name, reason, owner):
	"""
	Create a Notification Log for the order submitter and push a realtime alert.
	"""
	frappe.get_doc(
		{
			"doctype": "Notification Log",
			"for_user": owner,
			"from_user": frappe.session.user,
			"subject": f"Finance rejected Sales Order {order_name}",
			"email_content": f"<p><strong>Reason:</strong> {frappe.utils.escape_html(reason)}</p>",
			"document_type": "Sales Order",
			"document_name": order_name,
			"type": "Alert",
			"read": 0,
		}
	).insert(ignore_permissions=True)

	frappe.publish_realtime(
		"eval_js",
		{
			"js": (
				f"frappe.show_alert({{"
				f"  message: '<strong>Finance rejected {frappe.utils.escape_html(order_name)}</strong><br>{frappe.utils.escape_html(reason)}',"
				f"  indicator: 'red'"
				f"}}, 20);"
			)
		},
		user=owner,
	)
