import { useState, useEffect } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { Key, Plus, Copy, Check, Trash2, Lock, Mail, Send, CheckCircle, XCircle, Loader2, Activity, HardDrive, Pencil, Play, Cloud } from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../hooks/useAuth';
import Button from '../components/Button';
import Card, { CardHeader, CardBody } from '../components/Card';
import Modal from '../components/Modal';
import { Input } from '../components/Input';
import { safeTimeAgo } from '../lib/dates';

export default function Settings() {
  const [searchParams] = useSearchParams();
  const { user, refreshUser, setAuthUser } = useAuth();
  const forcePasswordChange = Boolean(user?.forcePasswordChange);
  const initialTab = searchParams.get('tab');
  const [tab, setTab] = useState(initialTab === 'password' ? 'password' : 'keys');

  useEffect(() => {
    if (forcePasswordChange && tab !== 'password') {
      setTab('password');
    }
  }, [forcePasswordChange, tab]);

  const tabClass = (t) => `px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
    tab === t ? 'border-primary-600 text-primary-600' : 'border-transparent text-gray-500 hover:text-gray-700'
  }`;

  return (
    <div className="p-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Settings</h1>
        <p className="text-gray-500">Manage your account and API access</p>
      </div>

      {forcePasswordChange && (
        <div className="mb-6 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          You must change your password before accessing other areas.
        </div>
      )}

      <div className="flex gap-1 mb-6 border-b border-gray-200">
        <button type="button" disabled={forcePasswordChange} className={tabClass('keys')} onClick={() => setTab('keys')}>API Keys</button>
        <button type="button" disabled={forcePasswordChange} className={tabClass('email')} onClick={() => setTab('email')}>Email Provider</button>
        <button type="button" disabled={forcePasswordChange} className={tabClass('storage')} onClick={() => setTab('storage')}>Cloud Storage</button>
        <button type="button" disabled={forcePasswordChange} className={tabClass('dispatcher')} onClick={() => setTab('dispatcher')}>Task Dispatcher</button>
        <button type="button" className={tabClass('password')} onClick={() => setTab('password')}>Password</button>
      </div>

      {tab === 'keys' && <ApiKeysSection />}
      {tab === 'email' && <EmailProviderSection />}
      {tab === 'storage' && <CloudStorageSection />}
      {tab === 'dispatcher' && <DispatcherSection />}
      {tab === 'password' && (
        <ChangePasswordSection
          forcePasswordChange={forcePasswordChange}
          onImmediateUnlock={setAuthUser}
          onBackgroundRefresh={refreshUser}
        />
      )}
    </div>
  );
}

function ApiKeysSection() {
  const [keys, setKeys] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showNewKey, setShowNewKey] = useState(null);
  const [generating, setGenerating] = useState(false);
  const [keyName, setKeyName] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    loadKeys();
  }, []);

  const loadKeys = async () => {
    try {
      const data = await api.userKeys.list();
      setKeys(data);
    } catch (err) {
      console.error('Failed to load keys:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleGenerate = async () => {
    setGenerating(true);
    try {
      const result = await api.userKeys.generate({ name: keyName || undefined });
      setShowNewKey(result);
      setKeyName('');
      loadKeys();
    } catch (err) {
      console.error('Failed to generate key:', err);
    } finally {
      setGenerating(false);
    }
  };

  const handleRevoke = async (keyId) => {
    if (!confirm('Revoke this API key? This cannot be undone.')) return;
    try {
      await api.userKeys.revoke(keyId);
      loadKeys();
    } catch (err) {
      console.error('Failed to revoke key:', err);
    }
  };

  const copyKey = () => {
    navigator.clipboard.writeText(showNewKey?.apiKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <h3 className="font-semibold text-gray-900">Personal API Keys</h3>
          <p className="text-sm text-gray-500">Use these keys to authenticate with the Cavendo API or MCP server</p>
        </CardHeader>
        <CardBody className="space-y-4">
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
            <p className="text-sm text-blue-700">
              Personal keys (<code className="font-mono">cav_uk_...</code>) authenticate as you. Use them in your MCP server config or direct API calls.
            </p>
          </div>

          <div className="flex gap-2">
            <Input
              placeholder="Key name (optional)"
              value={keyName}
              onChange={(e) => setKeyName(e.target.value)}
              className="flex-1"
            />
            <Button onClick={handleGenerate} loading={generating}>
              <Plus className="w-4 h-4" /> Generate Key
            </Button>
          </div>

          {loading ? (
            <div className="animate-pulse space-y-2">
              <div className="h-12 bg-gray-200 rounded"></div>
            </div>
          ) : (
            <div className="space-y-2">
              {keys.map((key) => (
                <div key={key.id} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                  <div className="flex items-center gap-4">
                    <Key className="w-4 h-4 text-gray-400" />
                    <div>
                      <div className="flex items-center gap-2">
                        <code className="text-sm font-mono">{key.prefix}...</code>
                        {key.name && <span className="text-sm text-gray-500">({key.name})</span>}
                      </div>
                      <div className="text-xs text-gray-400">
                        Created {safeTimeAgo(key.createdAt)}
                        {key.lastUsedAt && <> · Last used {safeTimeAgo(key.lastUsedAt)}</>}
                      </div>
                    </div>
                  </div>
                  <Button variant="ghost" size="sm" onClick={() => handleRevoke(key.id)}>
                    <Trash2 className="w-4 h-4 text-red-500" />
                  </Button>
                </div>
              ))}

              {keys.length === 0 && (
                <p className="text-center text-gray-500 py-4">No API keys yet</p>
              )}
            </div>
          )}
        </CardBody>
      </Card>

      {showNewKey && (
        <Modal isOpen={true} onClose={() => setShowNewKey(null)} title="API Key Generated">
          <div className="space-y-4">
            <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
              <p className="text-sm text-yellow-800">
                <strong>Important:</strong> This key will only be shown once. Store it securely now.
              </p>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">API Key</label>
              <div className="flex gap-2">
                <code className="flex-1 bg-gray-100 px-3 py-2 rounded text-sm font-mono break-all">
                  {showNewKey.apiKey}
                </code>
                <Button variant="secondary" onClick={copyKey}>
                  {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                </Button>
              </div>
            </div>

            <div className="bg-gray-50 border border-gray-200 rounded-lg p-3">
              <p className="text-sm text-gray-600">
                Use this key as <code className="font-mono">CAVENDO_AGENT_KEY</code> in your MCP server configuration.
              </p>
            </div>

            <div className="flex justify-end">
              <Button onClick={() => setShowNewKey(null)}>Done</Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

function EmailProviderSection() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [message, setMessage] = useState(null);
  const [testEmail, setTestEmail] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);

  // Form state — flat EMAIL_* key-value pairs
  const [form, setForm] = useState({
    EMAIL_PROVIDER: 'smtp',
    EMAIL_FROM: '',
    EMAIL_FROM_NAME: 'Cavendo',
    EMAIL_SMTP_HOST: '',
    EMAIL_SMTP_PORT: '587',
    EMAIL_SMTP_SECURE: 'false',
    EMAIL_SMTP_USER: '',
    EMAIL_SMTP_PASS: '',
    EMAIL_SENDGRID_API_KEY: '',
    EMAIL_MAILJET_API_KEY: '',
    EMAIL_MAILJET_SECRET_KEY: '',
    EMAIL_POSTMARK_SERVER_TOKEN: '',
    EMAIL_SES_REGION: '',
    EMAIL_SES_ACCESS_KEY_ID: '',
    EMAIL_SES_SECRET_ACCESS_KEY: ''
  });

  const [configured, setConfigured] = useState(false);

  useEffect(() => {
    loadConfig();
  }, []);

  const loadConfig = async () => {
    try {
      const data = await api.settings.getEmail();
      // Map the nested response back to flat EMAIL_* keys
      setForm({
        EMAIL_PROVIDER: data.provider || 'smtp',
        EMAIL_FROM: data.from || '',
        EMAIL_FROM_NAME: data.fromName || 'Cavendo',
        EMAIL_SMTP_HOST: data.smtp?.host || '',
        EMAIL_SMTP_PORT: String(data.smtp?.port || '587'),
        EMAIL_SMTP_SECURE: data.smtp?.secure ? 'true' : 'false',
        EMAIL_SMTP_USER: data.smtp?.user || '',
        EMAIL_SMTP_PASS: data.smtp?.pass || '',
        EMAIL_SENDGRID_API_KEY: data.sendgrid?.apiKey || '',
        EMAIL_MAILJET_API_KEY: data.mailjet?.apiKey || '',
        EMAIL_MAILJET_SECRET_KEY: data.mailjet?.secretKey || '',
        EMAIL_POSTMARK_SERVER_TOKEN: data.postmark?.serverToken || '',
        EMAIL_SES_REGION: data.ses?.region || '',
        EMAIL_SES_ACCESS_KEY_ID: data.ses?.accessKeyId || '',
        EMAIL_SES_SECRET_ACCESS_KEY: data.ses?.secretAccessKey || ''
      });
      setConfigured(data.configured);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const updateField = (key, value) => {
    setForm(prev => ({ ...prev, [key]: value }));
    setMessage(null);
  };

  const handleSave = async (e) => {
    e.preventDefault();
    setSaving(true);
    setMessage(null);
    try {
      await api.settings.updateEmail(form);
      setMessage({ type: 'success', text: 'Email settings saved. Server is restarting to apply changes...' });
      // Poll until server comes back
      setTimeout(async () => {
        for (let i = 0; i < 20; i++) {
          await new Promise(r => setTimeout(r, 1500));
          try {
            await api.settings.getEmail();
            setMessage({ type: 'success', text: 'Email settings saved and server restarted successfully.' });
            loadConfig();
            return;
          } catch (_) {
            // Server still restarting
          }
        }
        setMessage({ type: 'success', text: 'Settings saved. If the server hasn\'t restarted, check your process manager.' });
      }, 1000);
    } catch (err) {
      setMessage({ type: 'error', text: err.message || 'Failed to save settings' });
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async (e) => {
    e.preventDefault();
    if (!testEmail) return;
    setTesting(true);
    setTestResult(null);
    try {
      const result = await api.settings.testEmail(testEmail);
      setTestResult(result);
    } catch (err) {
      setTestResult({ sent: false, error: err.message });
    } finally {
      setTesting(false);
    }
  };

  if (loading) {
    return (
      <Card>
        <CardBody>
          <div className="animate-pulse space-y-3">
            <div className="h-4 bg-gray-200 rounded w-1/3"></div>
            <div className="h-8 bg-gray-200 rounded"></div>
            <div className="h-8 bg-gray-200 rounded"></div>
          </div>
        </CardBody>
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <CardBody>
          <div className="bg-red-50 border border-red-200 rounded-lg p-4">
            <p className="text-sm text-red-700">Failed to load email config: {error}</p>
          </div>
        </CardBody>
      </Card>
    );
  }

  const providers = [
    { value: 'smtp', label: 'SMTP' },
    { value: 'sendgrid', label: 'SendGrid' },
    { value: 'mailjet', label: 'Mailjet' },
    { value: 'postmark', label: 'Postmark' },
    { value: 'ses', label: 'AWS SES' }
  ];

  const isMasked = (val) => typeof val === 'string' && val.startsWith('••');

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <h3 className="font-semibold text-gray-900">Email Provider</h3>
              <p className="text-sm text-gray-500">Configure the email provider used for delivery route notifications</p>
            </div>
            <div className="flex items-center gap-2">
              {configured ? (
                <>
                  <CheckCircle className="w-4 h-4 text-green-500" />
                  <span className="text-sm text-green-700">Configured</span>
                </>
              ) : (
                <>
                  <XCircle className="w-4 h-4 text-amber-500" />
                  <span className="text-sm text-amber-700">Not configured</span>
                </>
              )}
            </div>
          </div>
        </CardHeader>
        <CardBody>
          <form onSubmit={handleSave} className="space-y-4">
            <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
              <p className="text-sm text-blue-700">
                Changes are saved to your <code className="font-mono text-xs bg-blue-100 px-1 py-0.5 rounded">.env</code> file. The server will automatically restart to apply the new configuration.
              </p>
            </div>

            {message && (
              <div className={`rounded-lg p-3 border ${
                message.type === 'success' ? 'bg-green-50 border-green-200' : 'bg-red-50 border-red-200'
              }`}>
                <p className={`text-sm ${message.type === 'success' ? 'text-green-700' : 'text-red-700'}`}>
                  {message.text}
                </p>
              </div>
            )}

            {/* Provider selection + common fields */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Provider</label>
                <select
                  value={form.EMAIL_PROVIDER}
                  onChange={(e) => updateField('EMAIL_PROVIDER', e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                >
                  {providers.map(p => (
                    <option key={p.value} value={p.value}>{p.label}</option>
                  ))}
                </select>
              </div>
              <Input
                label="From Email"
                type="email"
                placeholder="notifications@yourdomain.com"
                value={form.EMAIL_FROM}
                onChange={(e) => updateField('EMAIL_FROM', e.target.value)}
              />
              <Input
                label="From Name"
                placeholder="Cavendo"
                value={form.EMAIL_FROM_NAME}
                onChange={(e) => updateField('EMAIL_FROM_NAME', e.target.value)}
              />
            </div>

            <hr className="border-gray-200" />

            {/* SMTP fields */}
            {form.EMAIL_PROVIDER === 'smtp' && (
              <div className="space-y-4">
                <h4 className="text-sm font-medium text-gray-700">SMTP Configuration</h4>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  <Input
                    label="Host"
                    placeholder="smtp.gmail.com"
                    value={form.EMAIL_SMTP_HOST}
                    onChange={(e) => updateField('EMAIL_SMTP_HOST', e.target.value)}
                  />
                  <Input
                    label="Port"
                    placeholder="587"
                    value={form.EMAIL_SMTP_PORT}
                    onChange={(e) => updateField('EMAIL_SMTP_PORT', e.target.value)}
                  />
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Secure (TLS)</label>
                    <label className="flex items-center gap-2 mt-2">
                      <input
                        type="checkbox"
                        checked={form.EMAIL_SMTP_SECURE === 'true'}
                        onChange={(e) => updateField('EMAIL_SMTP_SECURE', e.target.checked ? 'true' : 'false')}
                        className="rounded border-gray-300 text-primary-600 focus:ring-primary-500"
                      />
                      <span className="text-sm text-gray-600">Enable TLS (port 465)</span>
                    </label>
                  </div>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <Input
                    label="Username"
                    placeholder="your-email@gmail.com"
                    value={form.EMAIL_SMTP_USER}
                    onChange={(e) => updateField('EMAIL_SMTP_USER', e.target.value)}
                  />
                  <Input
                    label="Password"
                    type="password"
                    placeholder={isMasked(form.EMAIL_SMTP_PASS) ? form.EMAIL_SMTP_PASS : 'your-app-password'}
                    value={isMasked(form.EMAIL_SMTP_PASS) ? '' : form.EMAIL_SMTP_PASS}
                    onChange={(e) => updateField('EMAIL_SMTP_PASS', e.target.value)}
                  />
                </div>
                {isMasked(form.EMAIL_SMTP_PASS) && (
                  <p className="text-xs text-gray-500">Password is set. Leave blank to keep the current value.</p>
                )}
              </div>
            )}

            {/* SendGrid fields */}
            {form.EMAIL_PROVIDER === 'sendgrid' && (
              <div className="space-y-4">
                <h4 className="text-sm font-medium text-gray-700">SendGrid Configuration</h4>
                <Input
                  label="API Key"
                  type="password"
                  placeholder={isMasked(form.EMAIL_SENDGRID_API_KEY) ? form.EMAIL_SENDGRID_API_KEY : 'SG.xxxx'}
                  value={isMasked(form.EMAIL_SENDGRID_API_KEY) ? '' : form.EMAIL_SENDGRID_API_KEY}
                  onChange={(e) => updateField('EMAIL_SENDGRID_API_KEY', e.target.value)}
                />
                {isMasked(form.EMAIL_SENDGRID_API_KEY) && (
                  <p className="text-xs text-gray-500">API key is set. Leave blank to keep the current value.</p>
                )}
              </div>
            )}

            {/* Mailjet fields */}
            {form.EMAIL_PROVIDER === 'mailjet' && (
              <div className="space-y-4">
                <h4 className="text-sm font-medium text-gray-700">Mailjet Configuration</h4>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <Input
                    label="API Key"
                    type="password"
                    placeholder={isMasked(form.EMAIL_MAILJET_API_KEY) ? form.EMAIL_MAILJET_API_KEY : 'your-api-key'}
                    value={isMasked(form.EMAIL_MAILJET_API_KEY) ? '' : form.EMAIL_MAILJET_API_KEY}
                    onChange={(e) => updateField('EMAIL_MAILJET_API_KEY', e.target.value)}
                  />
                  <Input
                    label="Secret Key"
                    type="password"
                    placeholder={isMasked(form.EMAIL_MAILJET_SECRET_KEY) ? form.EMAIL_MAILJET_SECRET_KEY : 'your-secret-key'}
                    value={isMasked(form.EMAIL_MAILJET_SECRET_KEY) ? '' : form.EMAIL_MAILJET_SECRET_KEY}
                    onChange={(e) => updateField('EMAIL_MAILJET_SECRET_KEY', e.target.value)}
                  />
                </div>
                {(isMasked(form.EMAIL_MAILJET_API_KEY) || isMasked(form.EMAIL_MAILJET_SECRET_KEY)) && (
                  <p className="text-xs text-gray-500">Keys are set. Leave blank to keep the current values.</p>
                )}
              </div>
            )}

            {/* Postmark fields */}
            {form.EMAIL_PROVIDER === 'postmark' && (
              <div className="space-y-4">
                <h4 className="text-sm font-medium text-gray-700">Postmark Configuration</h4>
                <Input
                  label="Server Token"
                  type="password"
                  placeholder={isMasked(form.EMAIL_POSTMARK_SERVER_TOKEN) ? form.EMAIL_POSTMARK_SERVER_TOKEN : 'your-server-token'}
                  value={isMasked(form.EMAIL_POSTMARK_SERVER_TOKEN) ? '' : form.EMAIL_POSTMARK_SERVER_TOKEN}
                  onChange={(e) => updateField('EMAIL_POSTMARK_SERVER_TOKEN', e.target.value)}
                />
                {isMasked(form.EMAIL_POSTMARK_SERVER_TOKEN) && (
                  <p className="text-xs text-gray-500">Server token is set. Leave blank to keep the current value.</p>
                )}
              </div>
            )}

            {/* AWS SES fields */}
            {form.EMAIL_PROVIDER === 'ses' && (
              <div className="space-y-4">
                <h4 className="text-sm font-medium text-gray-700">AWS SES Configuration</h4>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  <Input
                    label="Region"
                    placeholder="us-east-1"
                    value={form.EMAIL_SES_REGION}
                    onChange={(e) => updateField('EMAIL_SES_REGION', e.target.value)}
                  />
                  <Input
                    label="Access Key ID"
                    type="password"
                    placeholder={isMasked(form.EMAIL_SES_ACCESS_KEY_ID) ? form.EMAIL_SES_ACCESS_KEY_ID : 'AKIA...'}
                    value={isMasked(form.EMAIL_SES_ACCESS_KEY_ID) ? '' : form.EMAIL_SES_ACCESS_KEY_ID}
                    onChange={(e) => updateField('EMAIL_SES_ACCESS_KEY_ID', e.target.value)}
                  />
                  <Input
                    label="Secret Access Key"
                    type="password"
                    placeholder={isMasked(form.EMAIL_SES_SECRET_ACCESS_KEY) ? form.EMAIL_SES_SECRET_ACCESS_KEY : 'your-secret-key'}
                    value={isMasked(form.EMAIL_SES_SECRET_ACCESS_KEY) ? '' : form.EMAIL_SES_SECRET_ACCESS_KEY}
                    onChange={(e) => updateField('EMAIL_SES_SECRET_ACCESS_KEY', e.target.value)}
                  />
                </div>
                {(isMasked(form.EMAIL_SES_ACCESS_KEY_ID) || isMasked(form.EMAIL_SES_SECRET_ACCESS_KEY)) && (
                  <p className="text-xs text-gray-500">Credentials are set. Leave blank to keep the current values.</p>
                )}
              </div>
            )}

            <div className="flex justify-end pt-2">
              <Button type="submit" loading={saving}>
                <Mail className="w-4 h-4" /> Save & Restart
              </Button>
            </div>
          </form>
        </CardBody>
      </Card>

      {configured && (
        <Card>
          <CardHeader>
            <h3 className="font-semibold text-gray-900">Send Test Email</h3>
            <p className="text-sm text-gray-500">Verify your email configuration is working</p>
          </CardHeader>
          <CardBody>
            <form onSubmit={handleTest} className="flex gap-2 items-end">
              <div className="flex-1">
                <Input
                  label="Recipient"
                  type="email"
                  placeholder="you@example.com"
                  value={testEmail}
                  onChange={(e) => setTestEmail(e.target.value)}
                  required
                />
              </div>
              <Button type="submit" loading={testing} disabled={testing || !testEmail}>
                <Send className="w-4 h-4" /> Send Test
              </Button>
            </form>

            {testResult && (
              <div className={`mt-3 rounded-lg p-3 border ${
                testResult.sent ? 'bg-green-50 border-green-200' : 'bg-red-50 border-red-200'
              }`}>
                <p className={`text-sm ${testResult.sent ? 'text-green-700' : 'text-red-700'}`}>
                  {testResult.sent ? 'Test email sent successfully!' : `Failed: ${testResult.error}`}
                </p>
              </div>
            )}
          </CardBody>
        </Card>
      )}
    </div>
  );
}

function DispatcherSection() {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    loadStatus();
  }, []);

  const loadStatus = async () => {
    try {
      const data = await api.settings.getDispatcher();
      setStatus(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <Card>
        <CardBody>
          <div className="animate-pulse space-y-3">
            <div className="h-4 bg-gray-200 rounded w-1/3"></div>
            <div className="h-8 bg-gray-200 rounded"></div>
          </div>
        </CardBody>
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <CardBody>
          <div className="bg-red-50 border border-red-200 rounded-lg p-4">
            <p className="text-sm text-red-700">Failed to load dispatcher status: {error}</p>
          </div>
        </CardBody>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <h3 className="font-semibold text-gray-900">Task Dispatcher</h3>
          <p className="text-sm text-gray-500">Background service that auto-executes tasks assigned to agents with automatic execution enabled</p>
        </CardHeader>
        <CardBody className="space-y-4">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Status</label>
              <div className="flex items-center gap-2">
                {status?.running ? (
                  <>
                    <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse"></div>
                    <span className="text-sm font-medium text-green-700">Running</span>
                  </>
                ) : (
                  <>
                    <div className="w-2 h-2 bg-gray-400 rounded-full"></div>
                    <span className="text-sm font-medium text-gray-500">Stopped</span>
                  </>
                )}
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Poll Interval</label>
              <span className="text-sm text-gray-900">{status?.pollIntervalMs ? `${status.pollIntervalMs / 1000}s` : '—'}</span>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Batch Size</label>
              <span className="text-sm text-gray-900">{status?.batchSize ?? '—'}</span>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Pending Auto Tasks</label>
              <span className="text-sm text-gray-900">{status?.pendingAutoTasks ?? '—'}</span>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mt-2">
            <div className="bg-gray-50 rounded-lg p-3 text-center">
              <div className="text-2xl font-bold text-gray-900">{status?.executionsLastHour ?? 0}</div>
              <div className="text-xs text-gray-500">Executions in last hour</div>
            </div>
            <div className="bg-gray-50 rounded-lg p-3 text-center">
              <div className={`text-2xl font-bold ${(status?.unroutedTasks || 0) > 0 ? 'text-amber-600' : 'text-gray-900'}`}>
                {status?.unroutedTasks ?? 0}
              </div>
              <div className="text-xs text-gray-500">Awaiting Routing</div>
            </div>
            <div className="bg-gray-50 rounded-lg p-3 text-center">
              <div className={`text-2xl font-bold ${(status?.recentErrors?.length || 0) > 0 ? 'text-red-600' : 'text-gray-900'}`}>
                {status?.recentErrors?.length ?? 0}
              </div>
              <div className="text-xs text-gray-500">Errors in last 24h</div>
            </div>
          </div>

          {status?.recentErrors?.length > 0 && (
            <>
              <hr className="border-gray-200" />
              <h4 className="text-sm font-medium text-red-600">Recent Errors</h4>
              <div className="space-y-2">
                {status.recentErrors.map((err, i) => (
                  <div key={i} className="p-2 bg-red-50 border border-red-100 rounded text-sm">
                    <div className="flex items-center justify-between">
                      <span className="text-red-800">Task #{err.taskId}</span>
                      <span className="text-xs text-red-400">{err.createdAt ? new Date(err.createdAt).toLocaleString() : ''}</span>
                    </div>
                    <p className="text-xs text-red-600 mt-1">
                      {err.detail?.error || err.detail?.agentName || JSON.stringify(err.detail)}
                    </p>
                  </div>
                ))}
              </div>
            </>
          )}

          <div className="bg-gray-50 border border-gray-200 rounded-lg p-3">
            <p className="text-xs text-gray-500">
              The dispatcher polls every {status?.pollIntervalMs ? `${status.pollIntervalMs / 1000} seconds` : '30 seconds'} for tasks assigned to agents with automatic execution enabled.
              Configure with <code className="font-mono bg-gray-100 px-1 py-0.5 rounded">DISPATCHER_INTERVAL_MS</code> and <code className="font-mono bg-gray-100 px-1 py-0.5 rounded">DISPATCHER_BATCH_SIZE</code> environment variables.
            </p>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <h3 className="font-semibold text-gray-900">Refresh</h3>
        </CardHeader>
        <CardBody>
          <Button variant="secondary" onClick={() => { setLoading(true); loadStatus(); }}>
            <Activity className="w-4 h-4" /> Refresh Status
          </Button>
        </CardBody>
      </Card>
    </div>
  );
}

function CloudStorageSection() {
  const [connections, setConnections] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editConn, setEditConn] = useState(null);
  const [formData, setFormData] = useState({ name: '', bucket: '', region: 'us-east-1', endpoint: '', access_key_id: '', secret_access_key: '' });
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    loadConnections();
  }, []);

  const loadConnections = async () => {
    setLoading(true);
    try {
      const data = await api.connections.list();
      setConnections(data);
    } catch (err) {
      console.error('Failed to load connections:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleCreate = () => {
    setEditConn(null);
    setFormData({ name: '', bucket: '', region: 'us-east-1', endpoint: '', access_key_id: '', secret_access_key: '' });
    setShowForm(true);
    setError('');
  };

  const handleEdit = (conn) => {
    setEditConn(conn);
    setFormData({ name: conn.name, bucket: conn.bucket, region: conn.region || 'us-east-1', endpoint: conn.endpoint || '', access_key_id: '', secret_access_key: '' });
    setShowForm(true);
    setError('');
  };

  const handleSubmit = async () => {
    setSaving(true);
    setError('');
    try {
      const payload = { ...formData };
      if (!payload.endpoint) delete payload.endpoint;
      if (editConn) {
        if (!payload.access_key_id) delete payload.access_key_id;
        if (!payload.secret_access_key) delete payload.secret_access_key;
        await api.connections.update(editConn.id, payload);
      } else {
        await api.connections.create(payload);
      }
      setShowForm(false);
      loadConnections();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id) => {
    if (!confirm('Delete this storage connection?')) return;
    try {
      await api.connections.delete(id);
      loadConnections();
    } catch (err) {
      alert(err.message);
    }
  };

  const handleTest = async (id) => {
    setTesting(id);
    try {
      await api.connections.test(id);
      alert('Connection successful!');
    } catch (err) {
      alert(`Connection failed: ${err.message}`);
    } finally {
      setTesting(null);
    }
  };

  if (loading) {
    return (
      <Card>
        <CardBody>
          <div className="animate-pulse space-y-3">
            <div className="h-4 bg-gray-200 rounded w-1/3"></div>
            <div className="h-8 bg-gray-200 rounded"></div>
          </div>
        </CardBody>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <h3 className="font-semibold text-gray-900">Cloud Storage Connections</h3>
              <p className="text-sm text-gray-500">S3-compatible storage for delivery route file uploads</p>
            </div>
            {!showForm && (
              <Button size="sm" onClick={handleCreate}>
                <Plus className="w-4 h-4" /> New Connection
              </Button>
            )}
          </div>
        </CardHeader>
        <CardBody>
          {showForm ? (
            <div className="space-y-4">
              <Input label="Connection Name" value={formData.name} onChange={(e) => setFormData({ ...formData, name: e.target.value })} placeholder="e.g. Production S3" />
              <Input label="Bucket" value={formData.bucket} onChange={(e) => setFormData({ ...formData, bucket: e.target.value })} />
              <div className="grid grid-cols-2 gap-4">
                <Input label="Region" value={formData.region} onChange={(e) => setFormData({ ...formData, region: e.target.value })} />
                <Input label="Endpoint URL (optional)" value={formData.endpoint} onChange={(e) => setFormData({ ...formData, endpoint: e.target.value })} placeholder="Leave empty for AWS S3" />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <Input label={editConn ? 'Access Key ID (leave blank to keep)' : 'Access Key ID'} value={formData.access_key_id} onChange={(e) => setFormData({ ...formData, access_key_id: e.target.value })} />
                <Input label={editConn ? 'Secret Access Key (leave blank to keep)' : 'Secret Access Key'} type="password" value={formData.secret_access_key} onChange={(e) => setFormData({ ...formData, secret_access_key: e.target.value })} />
              </div>
              {error && <p className="text-sm text-red-600">{error}</p>}
              <div className="flex justify-end gap-3 pt-2">
                <Button type="button" variant="secondary" onClick={() => setShowForm(false)}>Cancel</Button>
                <Button type="button" loading={saving} onClick={handleSubmit}
                  disabled={saving || (!editConn && (!formData.name || !formData.bucket || !formData.access_key_id || !formData.secret_access_key))}>
                  {editConn ? 'Update' : 'Create'}
                </Button>
              </div>
            </div>
          ) : connections.length === 0 ? (
            <div className="text-center py-8">
              <Cloud className="w-12 h-12 text-gray-300 mx-auto mb-3" />
              <p className="text-gray-500">No storage connections configured</p>
              <p className="text-sm text-gray-400 mt-1">Add an S3-compatible connection for delivery route file uploads</p>
            </div>
          ) : (
            <div className="space-y-2">
              {connections.map((conn) => (
                <div key={conn.id} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <HardDrive className="w-4 h-4 text-gray-400 shrink-0" />
                      <span className="font-medium text-gray-900">{conn.name}</span>
                    </div>
                    <div className="text-sm text-gray-500 mt-0.5 ml-6">
                      s3://{conn.bucket} · {conn.region}
                      {conn.accessKeyIdPreview && <> · Key: {conn.accessKeyIdPreview}</>}
                      {conn.routeCount > 0 && <> · Used by {conn.routeCount} route{conn.routeCount !== 1 ? 's' : ''}</>}
                    </div>
                  </div>
                  <div className="flex gap-1 shrink-0">
                    <Button variant="ghost" size="sm" onClick={() => handleTest(conn.id)} disabled={testing === conn.id}>
                      {testing === conn.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => handleEdit(conn)}>
                      <Pencil className="w-4 h-4" />
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => handleDelete(conn.id)}>
                      <Trash2 className="w-4 h-4 text-red-500" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  );
}

function ChangePasswordSection({ forcePasswordChange, onImmediateUnlock, onBackgroundRefresh }) {
  const [formData, setFormData] = useState({ currentPassword: '', newPassword: '', confirmPassword: '' });
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);
  const navigate = useNavigate();

  const handleSubmit = async (e) => {
    e.preventDefault();
    setMessage(null);

    if (formData.newPassword !== formData.confirmPassword) {
      setMessage({ type: 'error', text: 'New passwords do not match.' });
      return;
    }

    if (formData.newPassword.length < 8) {
      setMessage({ type: 'error', text: 'Password must be at least 8 characters.' });
      return;
    }

    setSaving(true);
    try {
      const data = await api.auth.changePassword(formData.currentPassword, formData.newPassword);
      setFormData({ currentPassword: '', newPassword: '', confirmPassword: '' });

      // Immediately update auth state from the change-password response
      // so forcePasswordChange is cleared without depending on /auth/me
      if (data.user && onImmediateUnlock) {
        onImmediateUnlock(data.user);
      }

      // Best-effort background sync (non-blocking)
      if (onBackgroundRefresh) {
        onBackgroundRefresh().catch(() => {});
      }

      // If this was a forced password change, navigate away from the lock screen
      if (forcePasswordChange) {
        navigate('/review', { replace: true });
      } else {
        setMessage({ type: 'success', text: 'Password changed successfully.' });
      }
    } catch (err) {
      setMessage({ type: 'error', text: err.message || 'Failed to change password.' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <h3 className="font-semibold text-gray-900">Change Password</h3>
      </CardHeader>
      <CardBody>
        <form onSubmit={handleSubmit} className="space-y-4 max-w-md">
          {message && (
            <div className={`rounded-lg p-3 border ${
              message.type === 'success' ? 'bg-green-50 border-green-200' : 'bg-red-50 border-red-200'
            }`}>
              <p className={`text-sm ${message.type === 'success' ? 'text-green-700' : 'text-red-700'}`}>
                {message.text}
              </p>
            </div>
          )}

          <Input
            label="Current Password"
            type="password"
            value={formData.currentPassword}
            onChange={(e) => setFormData({ ...formData, currentPassword: e.target.value })}
            required
          />
          <Input
            label="New Password"
            type="password"
            value={formData.newPassword}
            onChange={(e) => setFormData({ ...formData, newPassword: e.target.value })}
            required
          />
          <Input
            label="Confirm New Password"
            type="password"
            value={formData.confirmPassword}
            onChange={(e) => setFormData({ ...formData, confirmPassword: e.target.value })}
            required
          />

          <div className="flex justify-end pt-2">
            <Button type="submit" loading={saving}>
              <Lock className="w-4 h-4" /> Change Password
            </Button>
          </div>
        </form>
      </CardBody>
    </Card>
  );
}
