import frappe


@frappe.whitelist()
def get_order_items(order_names):
    if isinstance(order_names, str):
        import json
        order_names = json.loads(order_names)

    if not order_names:
        return []

    return frappe.db.get_all(
        "Sales Order Item",
        fields=["parent", "item_code", "item_name", "qty", "delivered_qty",
                "uom", "weight_per_unit", "rate", "amount"],
        filters=[["parent", "in", order_names]],
        limit=0,
    )
