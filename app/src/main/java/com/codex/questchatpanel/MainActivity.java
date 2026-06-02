package com.codex.questchatpanel;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageInfo;
import android.os.BatteryManager;
import android.os.Build;
import android.os.Bundle;
import android.view.InputDevice;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.View;
import android.view.View.OnGenericMotionListener;
import android.view.View.OnKeyListener;
import android.webkit.JavascriptInterface;
import android.view.Window;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONObject;

import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetAddress;
import java.nio.charset.StandardCharsets;

public class MainActivity extends Activity {
    private static final int DISCOVERY_PORT = 8788;
    private static final String DISCOVERY_REQUEST = "QUEST_CHAT_DISCOVER";
    private volatile boolean discoveryRunning;
    private WebView webView;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        requestWindowFeature(Window.FEATURE_NO_TITLE);

        webView = new WebView(this);
        setContentView(webView);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        settings.setAllowFileAccessFromFileURLs(true);
        settings.setAllowUniversalAccessFromFileURLs(true);
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(true);

        webView.setFocusable(true);
        webView.setFocusableInTouchMode(true);
        webView.addJavascriptInterface(new QuestBridge(), "QuestBridge");
        webView.setWebChromeClient(new WebChromeClient());
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                startRelayDiscovery(view);
            }
        });
        webView.setBackgroundColor(0xFF07090D);
        webView.setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                        | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN);
        webView.setOnGenericMotionListener(new OnGenericMotionListener() {
            @Override
            public boolean onGenericMotion(View v, MotionEvent event) {
                return handleControllerMotion(event);
            }
        });
        webView.setOnKeyListener(new OnKeyListener() {
            @Override
            public boolean onKey(View v, int keyCode, KeyEvent event) {
                return event.getAction() == KeyEvent.ACTION_DOWN && handleControllerKey(keyCode);
            }
        });
        webView.loadUrl("file:///android_asset/index.html");
        webView.requestFocus();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) {
            startRelayDiscovery(webView);
        }
    }

    @Override
    protected void onDestroy() {
        discoveryRunning = false;
        super.onDestroy();
    }

    @Override
    public boolean onGenericMotionEvent(MotionEvent event) {
        return handleControllerMotion(event) || super.onGenericMotionEvent(event);
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        return handleControllerKey(keyCode) || super.onKeyDown(keyCode, event);
    }

    @Override
    public boolean dispatchGenericMotionEvent(MotionEvent event) {
        return handleControllerMotion(event) || super.dispatchGenericMotionEvent(event);
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        if (event != null && event.getAction() == KeyEvent.ACTION_DOWN && handleControllerKey(event.getKeyCode())) {
            return true;
        }
        return super.dispatchKeyEvent(event);
    }

    private void startRelayDiscovery(WebView webView) {
        if (discoveryRunning) {
            return;
        }
        discoveryRunning = true;
        new Thread(() -> {
            try (DatagramSocket socket = new DatagramSocket()) {
                socket.setBroadcast(true);
                socket.setSoTimeout(2000);

                byte[] request = DISCOVERY_REQUEST.getBytes(StandardCharsets.UTF_8);
                byte[] response = new byte[1024];

                for (int attempt = 0; discoveryRunning; attempt++) {
                    DatagramPacket outgoing = new DatagramPacket(
                            request,
                            request.length,
                            InetAddress.getByName("255.255.255.255"),
                            DISCOVERY_PORT);
                    socket.send(outgoing);

                    long deadline = System.currentTimeMillis() + 1800;
                    while (discoveryRunning && System.currentTimeMillis() < deadline) {
                        try {
                            DatagramPacket incoming = new DatagramPacket(response, response.length);
                            socket.receive(incoming);
                            String text = new String(incoming.getData(), 0, incoming.getLength(), StandardCharsets.UTF_8);
                            JSONObject payload = new JSONObject(text);
                            String url = payload.optString("url", "");
                            if (url.startsWith("ws://") || url.startsWith("wss://")) {
                                discoveryRunning = false;
                                runOnUiThread(() -> webView.evaluateJavascript(
                                        "window.autoConnectRelay && window.autoConnectRelay(" + JSONObject.quote(url) + ")",
                                        null));
                                return;
                            }
                        } catch (Exception ignored) {
                        }
                    }

                    Thread.sleep(1200);
                }
            } catch (Exception ignored) {
            }
        }, "QuestChatRelayDiscovery").start();
    }

    private float pickScrollAxis(MotionEvent event) {
        float[] candidates = new float[] {
                centeredAxis(event, MotionEvent.AXIS_VSCROLL),
                centeredAxis(event, MotionEvent.AXIS_RY),
                centeredAxis(event, MotionEvent.AXIS_Y),
                centeredAxis(event, MotionEvent.AXIS_Z),
                centeredAxis(event, MotionEvent.AXIS_RZ)
        };
        for (float value : candidates) {
            if (Math.abs(value) > 0.16f) {
                return value;
            }
        }
        return 0f;
    }

    private boolean handleControllerMotion(MotionEvent event) {
        if (event != null
                && (event.getSource() & InputDevice.SOURCE_JOYSTICK) == InputDevice.SOURCE_JOYSTICK
                && event.getAction() == MotionEvent.ACTION_MOVE) {
            float axis = pickScrollAxis(event);
            if (Math.abs(axis) > 0.12f) {
                scrollChatBy(Math.round(axis * 120f));
                return true;
            }
        }
        return false;
    }

    private boolean handleControllerKey(int keyCode) {
        if (keyCode == KeyEvent.KEYCODE_DPAD_DOWN) {
            scrollChatBy(120);
            return true;
        }
        if (keyCode == KeyEvent.KEYCODE_DPAD_UP) {
            scrollChatBy(-120);
            return true;
        }
        if (keyCode == KeyEvent.KEYCODE_PAGE_DOWN) {
            scrollChatBy(360);
            return true;
        }
        if (keyCode == KeyEvent.KEYCODE_PAGE_UP) {
            scrollChatBy(-360);
            return true;
        }
        return false;
    }

    private float centeredAxis(MotionEvent event, int axis) {
        InputDevice device = event.getDevice();
        if (device == null) {
            return 0f;
        }
        InputDevice.MotionRange range = device.getMotionRange(axis, event.getSource());
        if (range == null) {
            return 0f;
        }
        float value = event.getAxisValue(axis);
        return Math.abs(value) > range.getFlat() ? value : 0f;
    }

    private void scrollChatBy(int delta) {
        if (webView == null) {
            return;
        }
        runOnUiThread(() -> webView.evaluateJavascript(
                "window.questNativeScrollBy && window.questNativeScrollBy(" + delta + ")",
                null));
    }

    private class QuestBridge {
        @JavascriptInterface
        public String getDeviceStatus() {
            try {
                Intent batteryIntent = registerReceiver(null, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
                int level = batteryIntent != null ? batteryIntent.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) : -1;
                int scale = batteryIntent != null ? batteryIntent.getIntExtra(BatteryManager.EXTRA_SCALE, 100) : 100;
                int statusCode = batteryIntent != null ? batteryIntent.getIntExtra(BatteryManager.EXTRA_STATUS, -1) : -1;
                String battery = level >= 0 && scale > 0
                        ? Math.round((level * 100f) / scale) + "%"
                        : "";
                String status = batteryStatusText(statusCode);

                JSONObject payload = new JSONObject();
                payload.put("connected", true);
                payload.put("questDevice", Build.MODEL != null ? Build.MODEL : "Quest");
                payload.put("questBattery", battery);
                payload.put("questBatteryStatus", status);
                payload.put("questApkVersion", installedVersion());
                payload.put("timestamp", System.currentTimeMillis());
                return payload.toString();
            } catch (Exception ignored) {
                return "{}";
            }
        }
    }

    private String installedVersion() {
        try {
            PackageInfo packageInfo = getPackageManager().getPackageInfo(getPackageName(), 0);
            return packageInfo.versionName != null ? packageInfo.versionName : "";
        } catch (Exception ignored) {
            return "";
        }
    }

    private String batteryStatusText(int statusCode) {
        switch (statusCode) {
            case BatteryManager.BATTERY_STATUS_CHARGING:
                return "charging";
            case BatteryManager.BATTERY_STATUS_DISCHARGING:
                return "discharging";
            case BatteryManager.BATTERY_STATUS_NOT_CHARGING:
                return "not charging";
            case BatteryManager.BATTERY_STATUS_FULL:
                return "full";
            default:
                return "";
        }
    }
}
