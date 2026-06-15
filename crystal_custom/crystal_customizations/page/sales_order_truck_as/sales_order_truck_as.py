import frappe

@frappe.whitelist()
def set_truck_number(order_name, truck_number):
    frappe.db.set_value('Sales Order', order_name, 'custom_truck_number', truck_number or '')
    return True

@frappe.whitelist()
def set_truck_closed(order_name, value=1):
    frappe.db.set_value('Sales Order', order_name, 'custom_truck_closed', int(value))
    return True

@frappe.whitelist()
def save_truck_meta(trucks_json):
    """Persist truck metadata (driver name, capacity) so it survives page reloads."""
    frappe.db.set_default('crystal_truck_meta', trucks_json)
    frappe.db.commit()
    return True

@frappe.whitelist()
def get_truck_meta():
    """Return previously saved truck metadata as a JSON string."""
    return frappe.db.get_default('crystal_truck_meta') or '[]'
