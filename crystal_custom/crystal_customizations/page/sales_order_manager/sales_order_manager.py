import frappe


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
def release_all_holds():
    """
    Bulk-reset custom_on_hold = 0 for all draft Sales Orders.
    Run once to fix orders mistakenly set to on-hold by the string-default bug
    (fixture had default: "0" instead of 0; JS treated the non-empty string as truthy).
    """
    result = frappe.db.sql("""
        UPDATE `tabSales Order`
        SET custom_on_hold = 0
        WHERE docstatus = 0
          AND custom_on_hold = 1
    """)
    frappe.db.commit()
    count = frappe.db.sql("SELECT ROW_COUNT() AS n", as_dict=1)[0].n
    return int(count)


@frappe.whitelist()
def send_to_finance(order_names):
    """
    Move draft Sales Orders to 'Pending Finance Approval' using a direct DB write
    so Frappe's workflow engine cannot auto-apply further transitions regardless
    of which roles the calling user holds.
    """
    import json

    if isinstance(order_names, str):
        order_names = json.loads(order_names)

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
        frappe.db.set_value(
            'Sales Order', name, 'workflow_state', 'Pending Finance Approval',
            update_modified=False,
        )
        updated.append(name)

    if updated:
        frappe.db.commit()

    return {'updated': updated, 'skipped': skipped}
