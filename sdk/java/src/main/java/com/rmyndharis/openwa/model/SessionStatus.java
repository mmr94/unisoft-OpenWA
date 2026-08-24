package com.rmyndharis.openwa.model;

import com.google.gson.annotations.SerializedName;

/**
 * Session lifecycle status. The wire values are lowercase/snake_case, so each
 * constant carries a {@link SerializedName} mapping.
 */
public enum SessionStatus {
    @SerializedName("created")
    CREATED,
    @SerializedName("initializing")
    INITIALIZING,
    @SerializedName("qr_ready")
    QR_READY,
    @SerializedName("authenticating")
    AUTHENTICATING,
    @SerializedName("ready")
    READY,
    @SerializedName("disconnected")
    DISCONNECTED,
    @SerializedName("action_required")
    ACTION_REQUIRED,
    @SerializedName("failed")
    FAILED,
    /** Engine unloaded after inactivity to free RAM; resuming needs no QR scan (Unisoft fork). */
    @SerializedName("hibernated")
    HIBERNATED
}
