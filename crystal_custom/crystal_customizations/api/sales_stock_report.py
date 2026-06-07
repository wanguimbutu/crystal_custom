import frappe
from frappe.utils import flt


@frappe.whitelist()
def get_report_data(from_date, to_date, warehouse=None):
    """
    Aggregate Sales Order Items (Submitted, within date range) per item+warehouse,
    then compare against current stock from the Bin doctype.
    """

    # ------------------------------------------------------------------
    # 1.  Pull Sales Order line items in the date range
    # ------------------------------------------------------------------
    filters = {
        "so.docstatus": 1,                          # Submitted only
        "so.transaction_date": ["between", [from_date, to_date]],
        "so.status": ["not in", ["Cancelled", "Closed"]],
    }

    so_items = frappe.db.sql(
        """
        SELECT
            soi.item_code,
            soi.item_name,
            soi.stock_uom,
            COALESCE(soi.warehouse, so.set_warehouse) AS warehouse,
            SUM(soi.qty - COALESCE(soi.delivered_qty, 0)) AS ordered_qty
        FROM
            `tabSales Order Item` soi
            INNER JOIN `tabSales Order` so ON so.name = soi.parent
        WHERE
            so.docstatus = 1
            AND so.transaction_date BETWEEN %(from_date)s AND %(to_date)s
            AND so.status NOT IN ('Cancelled', 'Closed')
            {warehouse_filter}
        GROUP BY
            soi.item_code,
            COALESCE(soi.warehouse, so.set_warehouse)
        HAVING
            ordered_qty > 0
        ORDER BY
            soi.item_code
        """.format(
            warehouse_filter="AND COALESCE(soi.warehouse, so.set_warehouse) = %(warehouse)s"
            if warehouse
            else ""
        ),
        {"from_date": from_date, "to_date": to_date, "warehouse": warehouse},
        as_dict=True,
    )

    if not so_items:
        return []

    # ------------------------------------------------------------------
    # 2.  Fetch actual stock quantities from Bin
    # ------------------------------------------------------------------
    item_warehouse_pairs = [
        (row["item_code"], row["warehouse"])
        for row in so_items
        if row.get("warehouse")
    ]

    # Build a lookup dict:  (item_code, warehouse) -> actual_qty
    stock_map = {}
    if item_warehouse_pairs:
        placeholders = ", ".join(
            ["(%s, %s)"] * len(item_warehouse_pairs)
        )
        flat_values = [v for pair in item_warehouse_pairs for v in pair]

        bin_rows = frappe.db.sql(
            """
            SELECT item_code, warehouse, actual_qty
            FROM `tabBin`
            WHERE (item_code, warehouse) IN ({})
            """.format(placeholders),
            flat_values,
            as_dict=True,
        )
        for b in bin_rows:
            stock_map[(b["item_code"], b["warehouse"])] = flt(b["actual_qty"])

    # ------------------------------------------------------------------
    # 3.  Build result rows
    # ------------------------------------------------------------------
    result = []
    for row in so_items:
        wh = row.get("warehouse") or ""
        actual = stock_map.get((row["item_code"], wh), 0.0)
        result.append(
            {
                "item_code": row["item_code"],
                "item_name": row["item_name"] or row["item_code"],
                "stock_uom": row["stock_uom"] or "Nos",
                "warehouse": wh,
                "ordered_qty": flt(row["ordered_qty"], 3),
                "actual_qty": flt(actual, 3),
            }
        )

    return result


# --------------------------------------------------------------------------
# Helper: get users with Manufacturing User / Manufacturing Manager roles
# --------------------------------------------------------------------------
def _get_manufacturing_users():
    users = frappe.db.sql(
        """
        SELECT DISTINCT u.name, u.full_name, u.email
        FROM `tabUser` u
        INNER JOIN `tabHas Role` hr ON hr.parent = u.name
        WHERE
            hr.role IN ('Manufacturing User', 'Manufacturing Manager')
            AND u.enabled = 1
            AND u.name != 'Guest'
        """,
        as_dict=True,
    )
    return users


# --------------------------------------------------------------------------
# Helper: send in-app notification + optional email
# --------------------------------------------------------------------------
def _notify_users(users, mr_name, item_code, item_name, qty, uom, warehouse):
    subject = f"Material Request {mr_name} raised – {item_code}"
    message = (
        f"A new Material Request <b>{mr_name}</b> has been created.<br><br>"
        f"<b>Item:</b> {item_code} – {item_name}<br>"
        f"<b>Required Qty:</b> {qty} {uom}<br>"
        f"<b>Warehouse:</b> {warehouse}<br><br>"
        f"Please review: <a href='/app/material-request/{mr_name}'>{mr_name}</a>"
    )

    for user in users:
        # In-app notification
        frappe.get_doc(
            {
                "doctype": "Notification Log",
                "subject": subject,
                "email_content": message,
                "for_user": user["name"],
                "type": "Alert",
                "document_type": "Material Request",
                "document_name": mr_name,
            }
        ).insert(ignore_permissions=True)

        # Email notification (non-blocking)
        if user.get("email"):
            frappe.sendmail(
                recipients=[user["email"]],
                subject=subject,
                message=message,
                delayed=True,
            )


@frappe.whitelist()
def create_material_request(item_code, warehouse, qty, uom, schedule_date, remarks=""):
    """Create a single Material Request for a deficit item and notify relevant roles."""

    qty = flt(qty)
    if qty <= 0:
        frappe.throw("Quantity must be greater than zero.")

    item_name = frappe.db.get_value("Item", item_code, "item_name") or item_code

    mr = frappe.get_doc(
        {
            "doctype": "Material Request",
            "material_request_type": "Purchase",
            "schedule_date": schedule_date,
            "transaction_date": frappe.utils.today(),
            "status": "Draft",
            "remarks": remarks
            or f"Auto-generated from Sales vs Stock Report for {item_code}",
            "items": [
                {
                    "item_code": item_code,
                    "item_name": item_name,
                    "qty": qty,
                    "uom": uom,
                    "stock_uom": uom,
                    "conversion_factor": 1.0,
                    "warehouse": warehouse,
                    "schedule_date": schedule_date,
                }
            ],
        }
    )
    mr.insert(ignore_permissions=True)
    mr.submit()

    users = _get_manufacturing_users()
    _notify_users(users, mr.name, item_code, item_name, qty, uom, warehouse)

    return {"mr_name": mr.name, "notified": len(users)}


@frappe.whitelist(allow_guest=False)
def create_material_requests_bulk(items, schedule_date):
    """
    Bulk-create one Material Request containing all deficit items,
    then notify Manufacturing Users and Managers once.
    """
    import json

    if isinstance(items, str):
        items = json.loads(items)

    if not items:
        frappe.throw("No items provided.")

    mr_items = []
    for item in items:
        item_name = frappe.db.get_value("Item", item["item_code"], "item_name") or item["item_code"]
        mr_items.append(
            {
                "item_code": item["item_code"],
                "item_name": item_name,
                "qty": flt(item["qty"]),
                "uom": item.get("uom", "Nos"),
                "stock_uom": item.get("uom", "Nos"),
                "conversion_factor": 1.0,
                "warehouse": item.get("warehouse", ""),
                "schedule_date": schedule_date,
            }
        )

    mr = frappe.get_doc(
        {
            "doctype": "Material Request",
            "material_request_type": "Purchase",
            "schedule_date": schedule_date,
            "transaction_date": frappe.utils.today(),
            "status": "Draft",
            "remarks": "Bulk auto-generated from Sales vs Stock Report",
            "items": mr_items,
        }
    )
    mr.insert(ignore_permissions=True)
    mr.submit()

    users = _get_manufacturing_users()
    item_summary = ", ".join([i["item_code"] for i in items[:5]])
    if len(items) > 5:
        item_summary += f" and {len(items) - 5} more"

    subject = f"Bulk Material Request {mr.name} raised ({len(items)} items)"
    message = (
        f"A bulk Material Request <b>{mr.name}</b> has been created with "
        f"<b>{len(items)} deficit item(s)</b>.<br><br>"
        f"<b>Items include:</b> {item_summary}<br><br>"
        f"Please review: <a href='/app/material-request/{mr.name}'>{mr.name}</a>"
    )

    for user in users:
        frappe.get_doc(
            {
                "doctype": "Notification Log",
                "subject": subject,
                "email_content": message,
                "for_user": user["name"],
                "type": "Alert",
                "document_type": "Material Request",
                "document_name": mr.name,
            }
        ).insert(ignore_permissions=True)
        if user.get("email"):
            frappe.sendmail(
                recipients=[user["email"]],
                subject=subject,
                message=message,
                delayed=True,
            )

    # Return a set of "item_code|warehouse" keys so the frontend can mark them done
    created_keys = [i["item_code"] + "|" + i.get("warehouse", "") for i in items]
    return {"mr_name": mr.name, "count": len(items), "notified": len(users), "created": created_keys}
