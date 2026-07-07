import frappe


@frappe.whitelist()
def get_orders(sales_persons_json=None, from_date=None, to_date=None, delivery_region=None):
    """
    Return draft Sales Orders at Proceed To Order / blank workflow state.
    Date filtering is done server-side so the full result set is correct
    regardless of how many total orders exist.
    """
    import json
    sps = json.loads(sales_persons_json) if sales_persons_json else []

    has_pf = frappe.db.has_column('Sales Order', 'custom_is_pre_fulfillment')
    pf_expr = 'IFNULL(so.custom_is_pre_fulfillment, 0) AS custom_is_pre_fulfillment' if has_pf else '0 AS custom_is_pre_fulfillment'

    sp_join  = ''
    sp_where = ''
    params   = {}
    if sps:
        sp_join  = 'INNER JOIN `tabSales Team` st ON st.parent = so.name AND st.parenttype = "Sales Order"'
        sp_ph    = ', '.join([f'%(sp{i})s' for i in range(len(sps))])
        sp_where = f'AND st.sales_person IN ({sp_ph})'
        params   = {f'sp{i}': sp for i, sp in enumerate(sps)}

    date_where = ''
    if from_date:
        params['from_date'] = from_date
        date_where += ' AND DATE(so.transaction_date) >= %(from_date)s'
    if to_date:
        params['to_date'] = to_date
        date_where += ' AND DATE(so.transaction_date) <= %(to_date)s'
    if delivery_region:
        params['delivery_region'] = delivery_region
        date_where += ' AND so.custom_delivery_region = %(delivery_region)s'

    rows = frappe.db.sql(f"""
        SELECT DISTINCT
            so.name,
            so.customer,
            so.customer_name,
            so.transaction_date,
            so.grand_total,
            so.custom_delivery_region,
            so.owner,
            so.workflow_state,
            so.custom_finance_rejection_note,
            so.custom_paint_notes,
            {pf_expr},
            (SELECT GROUP_CONCAT(DISTINCT st2.sales_person
                                 ORDER BY st2.sales_person SEPARATOR ', ')
             FROM `tabSales Team` st2
             WHERE st2.parent = so.name) AS sales_persons
        FROM `tabSales Order` so
        {sp_join}
        WHERE so.docstatus = 0
          AND (so.workflow_state IS NULL OR so.workflow_state = '' OR so.workflow_state = 'Proceed To Order')
          {sp_where}
          {date_where}
        ORDER BY so.transaction_date DESC
        LIMIT 500
    """, params, as_dict=1)
    return rows


@frappe.whitelist()
def notify_finance_of_new_orders(order_names):
    """
    Notify all Accounts Manager / Finance Manager users that new orders
    are pending finance approval. Called after send_to_finance succeeds.
    """
    import json
    if isinstance(order_names, str):
        order_names = json.loads(order_names)
    if not order_names:
        return

    finance_users = frappe.db.sql("""
        SELECT DISTINCT u.name
        FROM `tabUser` u
        INNER JOIN `tabHas Role` hr ON hr.parent = u.name AND hr.parenttype = 'User'
        WHERE hr.role IN ('Accounts Manager', 'Finance Manager')
          AND u.enabled = 1
          AND u.name != 'Administrator'
          AND u.name != %(sender)s
    """, {'sender': frappe.session.user}, as_dict=1)

    if not finance_users:
        return

    count   = len(order_names)
    plural  = 's' if count != 1 else ''
    sender  = frappe.utils.get_fullname(frappe.session.user)
    subject = f"{count} new order{plural} pending Finance Approval"
    sample  = ', '.join(order_names[:3]) + (f' … (+{count - 3} more)' if count > 3 else '')
    content = (
        f"<p><strong>{count}</strong> sales order{plural} sent for finance approval "
        f"by {frappe.utils.escape_html(sender)}:<br>{sample}</p>"
    )
    rt_msg  = f"{count} new order{plural} pending your Finance Approval"

    for user in finance_users:
        frappe.get_doc({
            'doctype':       'Notification Log',
            'for_user':      user.name,
            'from_user':     frappe.session.user,
            'subject':       subject,
            'email_content': content,
            'document_type': 'Sales Order',
            'document_name': order_names[0],
            'type':          'Alert',
            'read':          0,
        }).insert(ignore_permissions=True)

        frappe.publish_realtime(
            'eval_js',
            {'js': f'frappe.show_alert({{message:"{rt_msg}",indicator:"blue"}},15);'},
            user=user.name,
        )

    frappe.db.commit()


@frappe.whitelist()
def send_to_finance(order_names, resubmission_note='', resubmission_orders=None):
    """
    Move draft Sales Orders to 'Pending Finance Approval' using a direct DB write
    so Frappe's workflow engine cannot auto-apply further transitions regardless
    of which roles the calling user holds.

    resubmission_note: note explaining what changed, for orders being re-sent after rejection
    resubmission_orders: JSON list of order names that are resubmissions (subset of order_names)
    """
    import json

    if isinstance(order_names, str):
        order_names = json.loads(order_names)
    if isinstance(resubmission_orders, str):
        resubmission_orders = json.loads(resubmission_orders) if resubmission_orders else []

    resub_set = set(resubmission_orders or [])
    valid_from = {'', None, 'Proceed To Order'}
    updated, skipped = [], []

    for name in order_names:
        current = frappe.db.get_value(
            'Sales Order', name, ['workflow_state', 'docstatus'], as_dict=1
        )
        if not current:
            skipped.append(name)
            continue
        if current.docstatus != 0 or current.workflow_state not in valid_from:
            skipped.append(name)
            continue

        fields = {'workflow_state': 'Pending Finance Approval'}
        if name in resub_set and resubmission_note:
            fields['custom_resubmission_note'] = resubmission_note

        frappe.db.set_value('Sales Order', name, fields, update_modified=False)
        updated.append(name)

    if updated:
        frappe.db.commit()

    return {'updated': updated, 'skipped': skipped}
