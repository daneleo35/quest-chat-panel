package com.codex.questchatpanel;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.content.IntentFilter;
import android.os.BatteryManager;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
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
        webView.loadUrl("file:///android_asset/index.html");
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
                payload.put("timestamp", System.currentTimeMillis());
                return payload.toString();
            } catch (Exception ignored) {
                return "{}";
            }
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
