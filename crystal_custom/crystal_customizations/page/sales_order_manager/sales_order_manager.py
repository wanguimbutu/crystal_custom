import frappe


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
