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

export interface ResetPasswordEmailProps {
  name: string;
  resetUrl: string;
  expiresMinutes: number;
}

/** E-mail de recuperação da palavra-passe (Resend). Mesmo visual do e-mail de confirmação. */
export default function ResetPasswordEmail({ name, resetUrl, expiresMinutes }: ResetPasswordEmailProps) {
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
          <Preview>Redefina a palavra-passe da sua conta Losambo</Preview>
          <Container className="bg-white border border-solid border-line rounded-[12px] max-w-[520px] mx-auto px-[32px] py-[32px]">
            <Section className="mb-[24px]">
              <Text className="m-0 text-[20px] font-bold text-ink">
                <span className="text-brand">●</span> Losambo
              </Text>
            </Section>
            <Heading as="h1" className="m-0 mb-[16px] text-[24px] font-semibold text-ink">
              Redefinir a palavra-passe
            </Heading>
            <Text className="m-0 mb-[24px] text-[16px] leading-[26px] text-ink">
              Olá {name}, recebemos um pedido para redefinir a palavra-passe da sua conta Losambo. Escolha uma nova
              palavra-passe no botão abaixo.
            </Text>
            <Button
              href={resetUrl}
              className="box-border bg-brand text-ink text-[16px] font-semibold no-underline rounded-[10px] px-[24px] py-[14px]"
            >
              Escolher nova palavra-passe
            </Button>
            <Text className="m-0 mt-[24px] text-[14px] leading-[22px] text-muted">
              Se o botão não funcionar, copie este link para o navegador:
              <br />
              <Link href={resetUrl} className="text-link break-all">
                {resetUrl}
              </Link>
            </Text>
            <Hr className="border-none border-t border-solid border-line my-[24px]" />
            <Text className="m-0 text-[13px] leading-[20px] text-muted">
              O link expira em {expiresMinutes} minutos e só pode ser usado uma vez. Se não pediu esta alteração, ignore
              este e-mail — a sua palavra-passe continua a mesma.
            </Text>
          </Container>
        </Body>
      </Tailwind>
    </Html>
  );
}

ResetPasswordEmail.PreviewProps = {
  name: 'Ana',
  resetUrl: 'https://message.beeznoo.ao/entrar#redefinir/exemplo',
  expiresMinutes: 60,
} satisfies ResetPasswordEmailProps;
