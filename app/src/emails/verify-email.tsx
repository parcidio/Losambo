import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Link,
  pixelBasedPreset,
  Preview,
  Section,
  Tailwind,
  Text,
} from 'react-email';

export interface VerifyEmailProps {
  name: string;
  verifyUrl: string;
  expiresHours: number;
}

/** E-mail de confirmação de conta (Resend). O logótipo é texto: muitos clientes de e-mail não mostram SVG. */
export default function VerifyEmail({ name, verifyUrl, expiresHours }: VerifyEmailProps) {
  return (
    <Html lang="pt">
      <Tailwind
        config={{
          presets: [pixelBasedPreset],
          theme: {
            extend: {
              colors: {
                brand: '#F6821F',
                ink: '#1D1F20',
                muted: '#4E5255',
                line: '#E3E4E6',
                link: '#B4540A',
              },
            },
          },
        }}
      >
        <Head />
        <Body className="bg-[#F6F6F7] font-sans m-0 py-[32px]">
          <Preview>Confirme o seu e-mail para ativar a conta Losambo</Preview>
          <Container className="bg-white border border-solid border-line rounded-[12px] max-w-[520px] mx-auto px-[32px] py-[32px]">
            <Section className="mb-[24px]">
              <Text className="m-0 text-[20px] font-bold text-ink">
                <span className="text-brand">●</span> Losambo
              </Text>
            </Section>
            <Heading as="h1" className="m-0 mb-[16px] text-[24px] font-semibold text-ink">
              Confirme o seu e-mail
            </Heading>
            <Text className="m-0 mb-[24px] text-[16px] leading-[26px] text-ink">
              Olá {name}, obrigado por criar conta na Losambo. Confirme o seu e-mail para ativar a conta e começar a
              enviar OTP e mensagens por WhatsApp.
            </Text>
            <Button
              href={verifyUrl}
              className="box-border bg-brand text-ink text-[16px] font-semibold no-underline rounded-[10px] px-[24px] py-[14px]"
            >
              Confirmar e-mail
            </Button>
            <Text className="m-0 mt-[24px] text-[14px] leading-[22px] text-muted">
              Se o botão não funcionar, copie este link para o navegador:
              <br />
              <Link href={verifyUrl} className="text-link break-all">
                {verifyUrl}
              </Link>
            </Text>
            <Hr className="border-none border-t border-solid border-line my-[24px]" />
            <Text className="m-0 text-[13px] leading-[20px] text-muted">
              O link expira em {expiresHours} horas. Se não criou esta conta, ignore este e-mail.
            </Text>
          </Container>
        </Body>
      </Tailwind>
    </Html>
  );
}

VerifyEmail.PreviewProps = {
  name: 'Ana',
  verifyUrl: 'https://message.beeznoo.ao/auth/verify-email?token=exemplo',
  expiresHours: 24,
} satisfies VerifyEmailProps;
