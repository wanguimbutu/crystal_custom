import frappe
import json


@frappe.whitelist()
def get_pending_orders():
    """Fetch all draft Sales Orders in 'Proceed to Order' workflow state."""
    return frappe.get_all(
        "Sales Order",
        filters={
            "docstatus": 0,
            "workflow_state": "Proceed to Order",
        },
        fields=[
            "name",
            "customer",
            "customer_name",
            "custom_delivery_region",
            "grand_total",
            "total_net_weight",
            "transaction_date",
            "custom_phone_number",
        ],
        order_by="transaction_date asc",
        limit_page_length=500,
    )


@frappe.whitelist()
def get_draft_routes():
    """Return all unsubmitted (draft) Delivery Routes for the Load dialog."""
    return frappe.get_all(
        "Delivery Route",
        filters={"docstatus": 0},
        fields=[
            "name",
            "route_name",
            "truck_type",
            "truck_number",
            "route_date",
            "status",
            "total_orders",
        ],
        order_by="modified desc",
        limit_page_length=100,
    )


@frappe.whitelist()
def get_route(name):
    """Return the full Delivery Route document."""
    doc = frappe.get_doc("Delivery Route", name)
    return doc.as_dict()


@frappe.whitelist()
def save_route(
    route_name,
    truck_type,
    truck_number,
    route_date,
    route_points,
    orders,
    notes="",
    existing_name=None,
):
    """
    Create or update a Delivery Route document (draft).
    orders: JSON list of {sales_order, customer_name, delivery_region, grand_total, total_net_weight}
    route_points: JSON list of {lat, lng, label}
    Returns the saved document name.
    """
    if isinstance(orders, str):
        orders = json.loads(orders)
    if isinstance(route_points, str):
        route_points = json.loads(route_points)

    doc_name = existing_name or route_name

    if frappe.db.exists("Delivery Route", doc_name):
        doc = frappe.get_doc("Delivery Route", doc_name)
        if doc.docstatus == 1:
            frappe.throw("This route is already submitted and cannot be edited.")
    else:
        doc = frappe.new_doc("Delivery Route")
        doc.route_name = route_name

    doc.truck_type = truck_type
    doc.truck_number = truck_number
    doc.route_date = route_date
    doc.route_points = json.dumps(route_points, ensure_ascii=False)
    doc.notes = notes

    doc.orders = []
    for o in orders:
        doc.append("orders", {
            "sales_order": o.get("sales_order") or o.get("name"),
            "customer_name": o.get("customer_name"),
            "delivery_region": o.get("custom_delivery_region") or o.get("delivery_region") or "",
            "grand_total": o.get("grand_total") or 0,
            "total_net_weight": o.get("total_net_weight") or 0,
        })

    doc.save(ignore_permissions=True)
    return doc.name


@frappe.whitelist()
def confirm_route(name):
    """Mark a draft route as Confirmed (still docstatus=0, but locked for review)."""
    doc = frappe.get_doc("Delivery Route", name)
    if doc.docstatus != 0:
        frappe.throw("Only draft routes can be confirmed.")
    doc.status = "Confirmed"
    doc.save(ignore_permissions=True)
    return doc.name


@frappe.whitelist()
def submit_route(name):
    """Submit the Delivery Route (docstatus → 1). Locks the document."""
    doc = frappe.get_doc("Delivery Route", name)
    if doc.docstatus != 0:
        frappe.throw("Route is already submitted or cancelled.")
    doc.submit()
    return doc.name


@frappe.whitelist()
def delete_route(name):
    """Delete a draft route."""
    doc = frappe.get_doc("Delivery Route", name)
    if doc.docstatus != 0:
        frappe.throw("Cannot delete a submitted route.")
    doc.delete(ignore_permissions=True)
    return "ok"
