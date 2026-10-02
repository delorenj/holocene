import java.io.StringReader;
import java.io.StringWriter;
import java.nio.file.Path;
import javax.xml.parsers.DocumentBuilderFactory;
import javax.xml.transform.TransformerFactory;
import javax.xml.transform.dom.DOMSource;
import javax.xml.transform.stream.StreamResult;
import javax.xml.transform.stream.StreamSource;

class SdkLicenseCheck {
    public static void main(String[] args) throws Exception {
        var dom = DocumentBuilderFactory.newInstance().newDocumentBuilder().parse(args[0]);
        String reference = dom.getElementsByTagName("uses-license").item(0).getAttributes().getNamedItem("ref").getNodeValue();
        var licenses = dom.getElementsByTagName("license");
        org.w3c.dom.Node selected = null;
        for (int i = 0; i < licenses.getLength(); i++) {
            var node = licenses.item(i);
            if (node.getAttributes().getNamedItem("id").getNodeValue().equals(reference)) selected = node;
        }
        if (selected == null) throw new AssertionError("Referenced license missing");
        var writer = new StringWriter();
        TransformerFactory.newInstance().newTransformer().transform(new DOMSource(selected), new StreamResult(writer));
        var contextClass = Class.forName("javax.xml.bind.JAXBContext");
        var licenseClass = Class.forName("com.android.repository.impl.generated.v1.LicenseType");
        var context = contextClass.getMethod("newInstance", Class[].class).invoke(null, (Object) new Class<?>[]{licenseClass});
        var unmarshaller = contextClass.getMethod("createUnmarshaller").invoke(context);
        var element = Class.forName("javax.xml.bind.Unmarshaller").getMethod("unmarshal", javax.xml.transform.Source.class, Class.class)
            .invoke(unmarshaller, new StreamSource(new StringReader(writer.toString())), licenseClass);
        var license = Class.forName("javax.xml.bind.JAXBElement").getMethod("getValue").invoke(element);
        String hash = (String) licenseClass.getMethod("getLicenseHash").invoke(license);
        boolean accepted = (Boolean) licenseClass.getMethod("checkAccepted", Path.class).invoke(license, Path.of(args[1]));
        System.out.println("SDK license hash=" + hash + "; checkAccepted=" + accepted + "; id=" + reference);
        if (!hash.equals(args[2]) || !accepted) throw new AssertionError("SDK license receipt not accepted");
    }
}
