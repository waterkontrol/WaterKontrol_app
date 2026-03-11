package com.waterkontrol.app;

import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private static final String APP_SCHEME = "com.waterkontrol.app";
    private static final String LOCAL_BASE_URL = "http://localhost";

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        handleAppLink(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleAppLink(intent);
    }

    private void handleAppLink(Intent intent) {
        if (intent == null) {
            return;
        }

        Uri data = intent.getData();
        if (data == null) {
            return;
        }

        String scheme = data.getScheme();
        String host = data.getHost();

        if (!APP_SCHEME.equals(scheme) || host == null) {
            return;
        }

        String targetUrl = null;

        if ("reset".equals(host)) {
            String token = data.getQueryParameter("token");
            if (token != null && !token.isEmpty()) {
                targetUrl = LOCAL_BASE_URL + "/reset.html?token=" + Uri.encode(token);
            }
        } else if ("login".equals(host)) {
            targetUrl = LOCAL_BASE_URL + "/login.html";
        }

        if (targetUrl == null || bridge == null || bridge.getWebView() == null) {
            return;
        }

        final String finalTargetUrl = targetUrl;
        bridge.getWebView().post(() -> bridge.getWebView().loadUrl(finalTargetUrl));
    }
}
