export default function Login() {
  return (
    <div className="login">
      <div className="login-card">
        <h1 className="logo" style={{ fontSize: 24, padding: "12px 16px" }}>
          What can
          <br />I cook
        </h1>
        <p className="login-text">
          This app is invite-only. Sign in with your Google account to get
          started.
        </p>
        <a href="/auth/google" className="login-btn">
          Sign in with Google
        </a>
      </div>
    </div>
  );
}
