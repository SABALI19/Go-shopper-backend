export const DELIVERY_TRANSITIONS = {
  awaiting_assignment: ["assigned"],
  assigned: ["accepted", "failed"],
  accepted: ["arrived_at_pickup", "in_transit", "failed"],
  arrived_at_pickup: ["picked_up", "failed"],
  picked_up: ["in_transit", "failed"],
  in_transit: ["delivered", "failed"],
  delivered: [],
  failed: ["assigned"],
};

export const ACTIVE_RIDER_DELIVERY_STATUSES = [
  "assigned", "accepted", "arrived_at_pickup", "picked_up", "in_transit",
];

export function isValidDeliveryTransition(from, to) {
  return DELIVERY_TRANSITIONS[from]?.includes(to) ?? false;
}

export function publicRiderProfile(user) {
  return {
    firstName: user.firstName || "",
    lastName: user.lastName || "",
    phone: user.phone || "",
    vehicleType: user.riderProfile?.vehicleType || "",
  };
}

export function publicDelivery(delivery, rider) {
  if (!delivery) return null;
  return {
    id: String(delivery._id),
    parentOrderNumber: delivery.parentOrderNumber,
    subOrderNumber: delivery.subOrderNumber,
    storeId: delivery.storeSlug,
    storeName: delivery.storeName,
    status: delivery.status,
    assignedAt: delivery.assignedAt,
    acceptedAt: delivery.acceptedAt,
    arrivedAt: delivery.arrivedAt,
    pickedUpAt: delivery.pickedUpAt,
    dispatchedAt: delivery.dispatchedAt,
    deliveredAt: delivery.deliveredAt,
    failedAt: delivery.failedAt,
    failureReason: delivery.failureReason || "",
    deliveryNotes: delivery.deliveryNotes || "",
    rider: rider ? publicRiderProfile(rider) : null,
    history: (delivery.history || []).map(({ action, fromStatus, toStatus, reason, createdAt }) => ({ action, fromStatus, toStatus, reason, createdAt })),
  };
}
