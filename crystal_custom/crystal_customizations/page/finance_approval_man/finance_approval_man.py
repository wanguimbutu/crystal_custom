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

	# ── Outstanding + Overdue from Sales Invoices ────────────────────────────
	invoice_rows = frappe.db.sql(
		f"""
		SELECT
			customer,
			IFNULL(SUM(outstanding_amount), 0)                                       AS outstanding,
			IFNULL(SUM(CASE WHEN due_date < %s THEN outstanding_amount ELSE 0 END), 0) AS overdue
		FROM `tabSales Invoice`
		WHERE customer IN ({placeholders})
		  AND docstatus = 1
		  AND outstanding_amount > 0
		GROUP BY customer
		""",
		[today] + customers,
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

	# ── PDC Cheques (Payment Entries with future posting_date) ───────────────
	pdc_rows = frappe.db.sql(
		f"""
		SELECT
			party                           AS customer,
			COUNT(*)                        AS pdc_count,
			IFNULL(SUM(paid_amount), 0)     AS pdc_amount
		FROM `tabPayment Entry`
		WHERE party_type  = 'Customer'
		  AND party IN ({placeholders})
		  AND docstatus   = 1
		  AND posting_date > %s
		  AND (mode_of_payment LIKE '%%Cheque%%' OR mode_of_payment LIKE '%%PDC%%')
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
			"outstanding": flt(inv.get("outstanding", 0)),
			"overdue": flt(inv.get("overdue", 0)),
			"credit_limit": credit_map.get(customer, 0),
			"payment_terms": terms_map.get(customer, ""),
			"pdc_count": int(pdc.get("pdc_count", 0)),
			"pdc_amount": flt(pdc.get("pdc_amount", 0)),
		}

	return result


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
