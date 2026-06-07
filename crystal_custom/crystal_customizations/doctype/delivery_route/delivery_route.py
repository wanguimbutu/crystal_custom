import frappe
from frappe.model.document import Document


class DeliveryRoute(Document):
    def before_save(self):
        self._recalculate_totals()

    def before_submit(self):
        if not self.orders:
            frappe.throw("Cannot submit a route with no orders.")
        if not self.route_points:
            frappe.throw("Cannot submit a route with no waypoints on the map.")
        self.status = "Confirmed"

    def _recalculate_totals(self):
        self.total_orders = len(self.orders)
        self.total_weight = sum(row.total_net_weight or 0 for row in self.orders)
        self.total_value = sum(row.grand_total or 0 for row in self.orders)
