import { NextRequest, NextResponse } from "next/server";

const KAKAO_TOKEN_URL = "https://kauth.kakao.com/oauth/token";
const KAKAO_USER_ME_URL = "https://kapi.kakao.com/v2/user/me";

export interface KakaoTokenResponse {
  access_token: string;
  token_type: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
}

export interface KakaoUserMeResponse {
  kakao_account?: {
    email?: string;
    profile?: {
      nickname?: string;
      profile_image_url?: string;
      thumbnail_image_url?: string;
    };
  };
  properties?: { nickname?: string; profile_image?: string; thumbnail_image?: string; [key: string]: unknown };
  nickname?: string;
}

/** authorization code로 토큰 발급 후 사용자 프로필(닉네임, 이메일) 반환 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { code, redirect_uri } = body as { code?: string; redirect_uri?: string };
    if (!code || !redirect_uri) {
      return NextResponse.json(
        { error: "code and redirect_uri are required" },
        { status: 400 }
      );
    }

    const restApiKey = process.env.KAKAO_REST_API_KEY;
    if (!restApiKey) {
      return NextResponse.json(
        { error: "KAKAO_REST_API_KEY is not configured" },
        { status: 500 }
      );
    }

    const tokenParams = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: restApiKey,
      redirect_uri,
      code,
    });
    const clientSecret = process.env.KAKAO_CLIENT_SECRET;
    if (clientSecret) {
      tokenParams.set("client_secret", clientSecret);
    }

    const tokenRes = await fetch(KAKAO_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded;charset=utf-8",
      },
      body: tokenParams.toString(),
    });

    if (!tokenRes.ok) {
      const errText = await tokenRes.text();
      console.error("Kakao token error:", tokenRes.status, errText);
      return NextResponse.json(
        { error: "Failed to get Kakao token" },
        { status: 502 }
      );
    }

    const tokenData = (await tokenRes.json()) as KakaoTokenResponse;
    const accessToken = tokenData.access_token;
    if (!accessToken) {
      return NextResponse.json(
        { error: "No access_token in response" },
        { status: 502 }
      );
    }

    const userRes = await fetch(KAKAO_USER_ME_URL, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });
    if (!userRes.ok) {
      const errText = await userRes.text();
      console.error("Kakao user/me error:", userRes.status, errText);
      return NextResponse.json(
        { error: "Failed to get user profile" },
        { status: 502 }
      );
    }

    const userData = (await userRes.json()) as KakaoUserMeResponse;
    const nicknameRaw = [
      userData.kakao_account?.profile?.nickname,
      userData.properties?.nickname,
      userData.nickname,
    ].find((v) => typeof v === "string" && (v as string).trim() !== "");
    const nickname = typeof nicknameRaw === "string" ? nicknameRaw.trim() : "";
    const email = userData.kakao_account?.email ?? "";
    const profileImageUrl =
      userData.kakao_account?.profile?.thumbnail_image_url ||
      userData.kakao_account?.profile?.profile_image_url ||
      userData.properties?.thumbnail_image ||
      userData.properties?.profile_image ||
      "";

    return NextResponse.json({ nickname, email, profileImageUrl: profileImageUrl || undefined });
  } catch (e) {
    console.error("Kakao token route error:", e);
    return NextResponse.json(
      { error: "Server error" },
      { status: 500 }
    );
  }
}
