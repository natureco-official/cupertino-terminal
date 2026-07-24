use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use reqwest::{Client, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    env, fs,
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};
use tempfile::NamedTempFile;
use url::Url;

const DEFAULT_SUPABASE_URL: &str = "https://mxnlehflfkesasclcldy.supabase.co";
const DEFAULT_SUPABASE_ANON: &str = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im14bmxlaGZsZmtlc2FzY2xjbGR5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY2NDA5MzEsImV4cCI6MjA5MjIxNjkzMX0.93aPOg6bVmgFaJvsM5jVZwiX2TTuFIyAzhP6BlhBkGU";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountError {
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    status_code: Option<u16>,
}

impl AccountError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            status_code: None,
        }
    }

    fn http(status: StatusCode, message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            status_code: Some(status.as_u16()),
        }
    }
}

impl From<std::io::Error> for AccountError {
    fn from(error: std::io::Error) -> Self {
        Self::new(format!("NatureCo session storage error: {error}"))
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct AccountUser {
    id: Option<String>,
    email: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct AccountSession {
    access_token: Option<String>,
    refresh_token: Option<String>,
    token_type: String,
    expires_at: Option<i64>,
    user: Option<AccountUser>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountStatus {
    pub logged_in: bool,
    pub email: Option<String>,
}

#[derive(Serialize)]
pub struct AccountEmail {
    pub email: Option<String>,
}

pub struct AccountService {
    client: Client,
    auth_base: String,
    anon_key: String,
    auth_file: PathBuf,
    file_lock: Mutex<()>,
}

impl AccountService {
    pub fn from_environment() -> Self {
        let base = env::var("NATURECO_SUPABASE_URL")
            .unwrap_or_else(|_| DEFAULT_SUPABASE_URL.to_owned())
            .trim_end_matches('/')
            .to_owned();
        let anon_key =
            env::var("NATURECO_SUPABASE_ANON").unwrap_or_else(|_| DEFAULT_SUPABASE_ANON.to_owned());
        Self {
            client: Client::new(),
            auth_base: format!("{base}/auth/v1"),
            anon_key,
            auth_file: natureco_auth_file(),
            file_lock: Mutex::new(()),
        }
    }

    fn load_session(&self) -> Option<AccountSession> {
        let _guard = self
            .file_lock
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        fs::read_to_string(&self.auth_file)
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
    }

    fn save_session(&self, session: &AccountSession) -> Result<(), AccountError> {
        let _guard = self
            .file_lock
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let parent = self
            .auth_file
            .parent()
            .ok_or_else(|| AccountError::new("NatureCo session path has no parent directory"))?;
        fs::create_dir_all(parent)?;
        let mut temp = NamedTempFile::new_in(parent)?;
        let bytes = serde_json::to_vec_pretty(session).map_err(|error| {
            AccountError::new(format!("Could not encode NatureCo session: {error}"))
        })?;
        temp.write_all(&bytes)?;
        temp.flush()?;
        temp.as_file().sync_all()?;
        set_private_permissions(temp.path())?;
        temp.persist(&self.auth_file)
            .map_err(|error| AccountError::from(error.error))?;
        set_private_permissions(&self.auth_file)?;
        Ok(())
    }

    pub fn logout(&self) -> Result<(), AccountError> {
        let _guard = self
            .file_lock
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        match fs::remove_file(&self.auth_file) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.into()),
        }
    }

    async fn post(&self, path: &str, body: Value) -> Result<Value, AccountError> {
        let response = self
            .client
            .post(format!("{}{}", self.auth_base, path))
            .header("apikey", &self.anon_key)
            .json(&body)
            .send()
            .await
            .map_err(|error| {
                AccountError::new(format!("NatureCo authentication request failed: {error}"))
            })?;
        let status = response.status();
        let data = response.json::<Value>().await.unwrap_or_else(|_| json!({}));
        if status.is_success() {
            Ok(data)
        } else {
            let message = ["error_description", "msg", "error"]
                .iter()
                .find_map(|key| data.get(key).and_then(Value::as_str))
                .map_or_else(
                    || format!("Authentication error ({})", status.as_u16()),
                    str::to_owned,
                );
            Err(AccountError::http(status, message))
        }
    }

    pub async fn login_with_password(
        &self,
        email: String,
        password: String,
    ) -> Result<AccountEmail, AccountError> {
        validate_email_and_secret(&email, &password)?;
        let data = self
            .post(
                "/token?grant_type=password",
                json!({ "email": email, "password": password }),
            )
            .await?;
        let session = shape_session(&data)?;
        let fallback = session.user.as_ref().and_then(|user| user.email.clone());
        self.save_session(&session)?;
        let me = self.whoami().await;
        Ok(AccountEmail {
            email: me
                .ok()
                .flatten()
                .and_then(|user| user.email)
                .or(fallback)
                .or(Some(email)),
        })
    }

    pub async fn send_otp(&self, email: String) -> Result<(), AccountError> {
        validate_email(&email)?;
        self.post("/otp", json!({ "email": email, "create_user": false }))
            .await?;
        Ok(())
    }

    pub async fn verify(&self, email: String, value: String) -> Result<AccountEmail, AccountError> {
        let value = value.trim();
        if value.is_empty() || value.len() > 32 * 1024 {
            return Err(AccountError::new("Enter an OTP code or login link"));
        }
        if value.starts_with("https://") || value.starts_with("http://") || value.contains("token")
        {
            self.verify_link(value).await?;
        } else {
            validate_email(&email)?;
            self.verify_otp(&email, value).await?;
        }
        let fallback = self.current_email();
        let me = self.whoami().await;
        Ok(AccountEmail {
            email: me.ok().flatten().and_then(|user| user.email).or(fallback),
        })
    }

    async fn verify_otp(&self, email: &str, token: &str) -> Result<(), AccountError> {
        let code: String = token
            .chars()
            .filter(|character| !character.is_whitespace())
            .collect();
        let first = self
            .post(
                "/verify",
                json!({ "type": "email", "email": email, "token": code }),
            )
            .await;
        let data = match first {
            Ok(data) => data,
            Err(first_error) => match self
                .post(
                    "/verify",
                    json!({ "type": "magiclink", "email": email, "token": code }),
                )
                .await
            {
                Ok(data) => data,
                Err(_) => return Err(first_error),
            },
        };
        self.save_session(&shape_session(&data)?)
    }

    async fn verify_link(&self, link: &str) -> Result<(), AccountError> {
        let parsed =
            Url::parse(link.trim()).map_err(|_| AccountError::new("Invalid login link"))?;
        if !matches!(parsed.scheme(), "http" | "https") {
            return Err(AccountError::new("Invalid login link"));
        }
        let params = link_params(&parsed);
        if let Some(access_token) = param(&params, "access_token") {
            let expires_at = param(&params, "expires_at")
                .and_then(|value| value.parse().ok())
                .or_else(|| {
                    param(&params, "expires_in")
                        .and_then(|value| value.parse::<i64>().ok())
                        .map(|seconds| unix_seconds().saturating_add(seconds))
                });
            let session = AccountSession {
                user: user_from_jwt(&access_token),
                access_token: Some(access_token),
                refresh_token: param(&params, "refresh_token"),
                token_type: param(&params, "token_type").unwrap_or_else(|| "bearer".into()),
                expires_at,
            };
            return self.save_session(&session);
        }
        let token_hash = param(&params, "token_hash")
            .or_else(|| param(&params, "token"))
            .ok_or_else(|| AccountError::new("No verification token was found in the link"))?;
        let kind = param(&params, "type").unwrap_or_else(|| "magiclink".into());
        let data = self
            .post("/verify", json!({ "type": kind, "token_hash": token_hash }))
            .await?;
        self.save_session(&shape_session(&data)?)
    }

    async fn refresh(&self, session: &AccountSession) -> Result<AccountSession, AccountError> {
        let refresh_token = session
            .refresh_token
            .as_deref()
            .ok_or_else(|| AccountError::http(StatusCode::UNAUTHORIZED, "No active session"))?;
        let data = self
            .post(
                "/token?grant_type=refresh_token",
                json!({ "refresh_token": refresh_token }),
            )
            .await?;
        let refreshed = shape_session(&data)?;
        self.save_session(&refreshed)?;
        Ok(refreshed)
    }

    async fn access_token(&self) -> Option<String> {
        let mut session = self.load_session()?;
        if session
            .expires_at
            .is_some_and(|expires_at| unix_seconds() > expires_at.saturating_sub(60))
        {
            session = self.refresh(&session).await.ok()?;
        }
        session.access_token
    }

    async fn whoami(&self) -> Result<Option<AccountUser>, AccountError> {
        let Some(token) = self.access_token().await else {
            return Ok(None);
        };
        let response = self
            .client
            .get(format!("{}/user", self.auth_base))
            .header("apikey", &self.anon_key)
            .bearer_auth(token)
            .send()
            .await
            .map_err(|error| {
                AccountError::new(format!("NatureCo account lookup failed: {error}"))
            })?;
        if !response.status().is_success() {
            return Ok(None);
        }
        response
            .json::<AccountUser>()
            .await
            .map(Some)
            .map_err(|error| {
                AccountError::new(format!("Invalid NatureCo account response: {error}"))
            })
    }

    fn current_email(&self) -> Option<String> {
        self.load_session()?.user?.email
    }

    pub async fn status(&self) -> AccountStatus {
        if self
            .load_session()
            .and_then(|session| session.access_token)
            .is_none()
        {
            return AccountStatus {
                logged_in: false,
                email: None,
            };
        }
        let fallback = self.current_email();
        let me = self.whoami().await.ok().flatten();
        AccountStatus {
            logged_in: me.is_some(),
            email: me.and_then(|user| user.email).or(fallback),
        }
    }
}

fn validate_email(email: &str) -> Result<(), AccountError> {
    if email.len() <= 320 && email.contains('@') {
        Ok(())
    } else {
        Err(AccountError::new("Enter a valid email address"))
    }
}

fn validate_email_and_secret(email: &str, secret: &str) -> Result<(), AccountError> {
    validate_email(email)?;
    if secret.is_empty() || secret.len() > 4096 {
        Err(AccountError::new("Enter a valid password"))
    } else {
        Ok(())
    }
}

fn shape_session(value: &Value) -> Result<AccountSession, AccountError> {
    let access_token = value
        .get("access_token")
        .and_then(Value::as_str)
        .map(str::to_owned);
    if access_token.is_none() {
        return Err(AccountError::new(
            "NatureCo authentication response did not include an access token",
        ));
    }
    let expires_at = value.get("expires_at").and_then(Value::as_i64).or_else(|| {
        value
            .get("expires_in")
            .and_then(Value::as_i64)
            .map(|seconds| unix_seconds().saturating_add(seconds))
    });
    Ok(AccountSession {
        access_token,
        refresh_token: value
            .get("refresh_token")
            .and_then(Value::as_str)
            .map(str::to_owned),
        token_type: value
            .get("token_type")
            .and_then(Value::as_str)
            .unwrap_or("bearer")
            .to_owned(),
        expires_at,
        user: value
            .get("user")
            .cloned()
            .and_then(|user| serde_json::from_value(user).ok()),
    })
}

fn user_from_jwt(token: &str) -> Option<AccountUser> {
    let encoded = token.split('.').nth(1)?;
    let bytes = URL_SAFE_NO_PAD.decode(encoded).ok()?;
    let payload: Value = serde_json::from_slice(&bytes).ok()?;
    Some(AccountUser {
        id: payload
            .get("sub")
            .and_then(Value::as_str)
            .map(str::to_owned),
        email: payload
            .get("email")
            .and_then(Value::as_str)
            .map(str::to_owned),
    })
}

fn link_params(url: &Url) -> Vec<(String, String)> {
    let mut values: Vec<(String, String)> = url.query_pairs().into_owned().collect();
    if let Some(fragment) = url.fragment() {
        values.extend(url::form_urlencoded::parse(fragment.as_bytes()).into_owned());
    }
    values
}

fn param(values: &[(String, String)], key: &str) -> Option<String> {
    values
        .iter()
        .rev()
        .find(|(name, _)| name == key)
        .map(|(_, value)| value.clone())
}

fn unix_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
        .try_into()
        .unwrap_or(i64::MAX)
}

fn natureco_auth_file() -> PathBuf {
    home_dir().join(".natureco").join("auth.json")
}

fn home_dir() -> PathBuf {
    env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .map(PathBuf::from)
        .filter(|path| path.is_dir())
        .or_else(|| env::current_dir().ok())
        .unwrap_or_else(|| PathBuf::from("."))
}

#[cfg(unix)]
fn set_private_permissions(path: &Path) -> Result<(), AccountError> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600)).map_err(Into::into)
}

#[cfg(not(unix))]
fn set_private_permissions(_path: &Path) -> Result<(), AccountError> {
    // The file is created inside the user's profile with Windows' user-scoped
    // inherited ACL. Unix targets additionally enforce an explicit 0600 mode.
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_shape_matches_javascript_contract() {
        let session = shape_session(&json!({
            "access_token": "access",
            "refresh_token": "refresh",
            "expires_in": 3600,
            "user": { "id": "u1", "email": "person@example.com" }
        }))
        .expect("valid session");
        assert_eq!(session.access_token.as_deref(), Some("access"));
        assert_eq!(
            session.user.and_then(|user| user.email).as_deref(),
            Some("person@example.com")
        );
        assert!(session.expires_at.is_some());
    }

    #[test]
    fn jwt_user_is_read_for_magic_link_sessions() {
        let payload = URL_SAFE_NO_PAD.encode(br#"{"sub":"u2","email":"magic@example.com"}"#);
        let user = user_from_jwt(&format!("header.{payload}.signature")).expect("JWT payload");
        assert_eq!(user.id.as_deref(), Some("u2"));
        assert_eq!(user.email.as_deref(), Some("magic@example.com"));
    }

    #[test]
    fn fragments_override_query_parameters() {
        let url = Url::parse(
            "https://natureco.me/callback?access_token=old#access_token=new&refresh_token=r",
        )
        .expect("URL");
        let values = link_params(&url);
        assert_eq!(param(&values, "access_token").as_deref(), Some("new"));
        assert_eq!(param(&values, "refresh_token").as_deref(), Some("r"));
    }
}
